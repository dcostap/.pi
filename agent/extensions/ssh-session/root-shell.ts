import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Client, ClientChannel } from "ssh2";
import { TailBuffer } from "../background-processes/tail-buffer.ts";
import {
	buildRootCommand,
	possibleMarkerSuffixLength,
	randomMarker,
	sanitizeTerminalText,
	shellQuote,
} from "./protocol.ts";

export interface RootExecutionOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly onData?: (chunk: Buffer) => void;
}

export interface RootExecutionResult {
	readonly exitCode: number;
	readonly output: ReturnType<TailBuffer["snapshot"]>;
}

interface PendingExecution {
	readonly beginMarker: string;
	readonly endMarker: string;
	readonly output: TailBuffer;
	readonly onData?: (chunk: Buffer) => void;
	resolve: (result: RootExecutionResult) => void;
	reject: (error: Error) => void;
	started: boolean;
	buffer: string;
	timer?: ReturnType<typeof setTimeout>;
	abortHandler?: () => void;
	signal?: AbortSignal;
}

export class RootShell {
	private pending?: PendingExecution;
	private queue: Promise<unknown> = Promise.resolve();
	private closed = false;

	private constructor(private readonly channel: ClientChannel) {
		channel.on("data", (chunk: Buffer) => this.receive(chunk));
		channel.stderr.on("data", (chunk: Buffer) => this.receive(chunk));
		channel.on("error", (error: Error) => this.fail(error));
		channel.on("close", () => this.fail(new Error("Privileged SSH channel closed")));
	}

	static async start(ctx: ExtensionCommandContext, client: Client): Promise<RootShell> {
		if (ctx.mode !== "tui") {
			throw new Error("Interactive sudo authorization currently requires Pi's TUI mode");
		}

		const readyMarker = randomMarker("ROOT_READY");
		const prompt = "[Pi SSH] sudo password: ";
		const remoteCommand =
			`sudo -p ${shellQuote(prompt)} -- /bin/sh -c ` +
			shellQuote(`stty -echo; printf '%s\\n' ${shellQuote(readyMarker)}; exec /bin/sh -s`);
		let rootShell: RootShell | undefined;

		const succeeded = await ctx.ui.custom<boolean>((tui, _theme, _keybindings, done) => {
			tui.stop();
			process.stdout.write("\nOpening a privileged channel. Enter the sudo password once; Ctrl+C cancels.\n\n");
			let channel: ClientChannel | undefined;
			let settled = false;
			let stdoutBuffer = "";
			const wasRaw = Boolean(process.stdin.isRaw);

			const finish = (ok: boolean, error?: string) => {
				if (settled) return;
				settled = true;
				process.stdin.off("data", onInput);
				if (channel) {
					channel.off("data", onStdout);
					channel.stderr.off("data", onStderr);
					channel.off("error", onError);
					channel.off("close", onClose);
					if (!ok) channel.close();
				}
				if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(wasRaw);
				if (error) process.stdout.write(`\n${sanitizeTerminalText(error)}\n`);
				tui.start();
				tui.requestRender(true);
				if (ok && channel) rootShell = new RootShell(channel);
				done(ok);
			};
			const onInput = (data: Buffer) => {
				if (channel?.writable) channel.write(data);
			};
			const onStdout = (data: Buffer) => {
				stdoutBuffer += data.toString("utf8");
				const markerIndex = stdoutBuffer.indexOf(readyMarker);
				if (markerIndex >= 0) {
					const visible = stdoutBuffer.slice(0, markerIndex);
					if (visible) process.stdout.write(sanitizeTerminalText(visible));
					finish(true);
					return;
				}
				const retained = possibleMarkerSuffixLength(stdoutBuffer, readyMarker);
				const visibleLength = stdoutBuffer.length - retained;
				if (visibleLength > 0) {
					process.stdout.write(sanitizeTerminalText(stdoutBuffer.slice(0, visibleLength)));
					stdoutBuffer = stdoutBuffer.slice(visibleLength);
				}
			};
			const onStderr = (data: Buffer) => process.stdout.write(sanitizeTerminalText(data.toString("utf8")));
			const onError = (error: Error) => finish(false, error.message);
			const onClose = () => finish(false, "Privileged channel closed before authorization completed");

			client.exec(remoteCommand, { pty: { term: "dumb", cols: 80, rows: 24 } }, (error, openedChannel) => {
				if (error) {
					finish(false, error.message);
					return;
				}
				channel = openedChannel;
				channel.on("data", onStdout);
				channel.stderr.on("data", onStderr);
				channel.on("error", onError);
				channel.on("close", onClose);
				process.stdin.on("data", onInput);
				process.stdin.resume();
				if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
			});

			return { render: () => [], invalidate: () => {} };
		});

		if (!succeeded || !rootShell) throw new Error("Sudo authorization was cancelled or failed");
		return rootShell;
	}

	execute(command: string, cwd: string, options: RootExecutionOptions = {}): Promise<RootExecutionResult> {
		const run = () => this.executeSerialized(command, cwd, options);
		const result = this.queue.then(run, run);
		this.queue = result.catch(() => undefined);
		return result;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.pending) this.pending.reject(new Error("Privileged SSH channel closed"));
		this.pending = undefined;
		if (this.channel.writable) this.channel.end("exit\n");
		await new Promise<void>((resolve) => {
			if (this.channel.destroyed) return resolve();
			const timer = setTimeout(() => {
				this.channel.close();
				resolve();
			}, 1500);
			this.channel.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	private executeSerialized(command: string, cwd: string, options: RootExecutionOptions): Promise<RootExecutionResult> {
		if (this.closed || this.channel.destroyed) throw new Error("Privileged SSH channel is not available");
		if (options.signal?.aborted) throw new Error("Privileged command aborted before launch");

		return new Promise<RootExecutionResult>((resolve, reject) => {
			const pending: PendingExecution = {
				beginMarker: randomMarker("BEGIN"),
				endMarker: randomMarker("END"),
				output: new TailBuffer(50 * 1024),
				onData: options.onData,
				resolve,
				reject,
				started: false,
				buffer: "",
				signal: options.signal,
			};
			this.pending = pending;
			const cleanupAndReject = (error: Error) => {
				this.cleanupPending(pending);
				if (this.pending === pending) this.pending = undefined;
				reject(error);
			};
			pending.reject = cleanupAndReject;
			pending.abortHandler = () => {
				if (this.channel.writable) this.channel.write(Buffer.from([3]));
			};
			options.signal?.addEventListener("abort", pending.abortHandler, { once: true });
			if (options.timeoutMs !== undefined) {
				pending.timer = setTimeout(() => {
					pending.abortHandler?.();
					this.closed = true;
					this.channel.close();
					cleanupAndReject(new Error(`Privileged command timed out after ${options.timeoutMs}ms`));
				}, options.timeoutMs);
			}
			this.channel.write(buildRootCommand(command, cwd, pending.beginMarker, pending.endMarker));
		});
	}

	private receive(chunk: Buffer): void {
		const pending = this.pending;
		if (!pending) return;
		pending.buffer += chunk.toString("utf8").replaceAll("\r", "");

		if (!pending.started) {
			const beginIndex = pending.buffer.indexOf(pending.beginMarker);
			if (beginIndex < 0) {
				const retained = possibleMarkerSuffixLength(pending.buffer, pending.beginMarker);
				pending.buffer = retained > 0 ? pending.buffer.slice(-retained) : "";
				return;
			}
			pending.started = true;
			pending.buffer = pending.buffer.slice(beginIndex + pending.beginMarker.length).replace(/^\n/u, "");
		}

		const endIndex = pending.buffer.indexOf(pending.endMarker);
		if (endIndex < 0) {
			const retained = possibleMarkerSuffixLength(pending.buffer, pending.endMarker);
			const outputLength = pending.buffer.length - retained;
			if (outputLength > 0) this.appendOutput(pending, pending.buffer.slice(0, outputLength));
			pending.buffer = pending.buffer.slice(outputLength);
			return;
		}

		const remainder = pending.buffer.slice(endIndex + pending.endMarker.length);
		const match = remainder.match(/^:(\d+)(?:\n|$)/u);
		if (!match) return;
		this.appendOutput(pending, pending.buffer.slice(0, endIndex).replace(/\n$/u, ""));
		const exitCode = Number(match[1]);
		this.cleanupPending(pending);
		this.pending = undefined;
		if (pending.signal?.aborted) pending.reject(new Error("Privileged command aborted"));
		else pending.resolve({ exitCode, output: pending.output.snapshot() });
	}

	private appendOutput(pending: PendingExecution, text: string): void {
		if (!text) return;
		const chunk = Buffer.from(text, "utf8");
		pending.output.append(chunk);
		try {
			pending.onData?.(chunk);
		} catch (error) {
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private cleanupPending(pending: PendingExecution): void {
		if (pending.timer) clearTimeout(pending.timer);
		if (pending.abortHandler) pending.signal?.removeEventListener("abort", pending.abortHandler);
	}

	private fail(error: Error): void {
		this.closed = true;
		const pending = this.pending;
		this.pending = undefined;
		if (pending) {
			this.cleanupPending(pending);
			pending.reject(error);
		}
	}
}
