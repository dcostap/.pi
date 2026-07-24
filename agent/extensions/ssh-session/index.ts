import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { spawnSync } from "node:child_process";
import type {
	BashOperations,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Client } from "ssh2";
import { BackgroundProcessManager, type BackgroundProcessSnapshot } from "../background-processes/manager.ts";
import { TailBuffer } from "../background-processes/tail-buffer.ts";
import {
	CommandOutputCapture,
	formatCapturedOutput,
	formatTailPreview,
	type CapturedOutput,
} from "./output-capture.ts";
import {
	downloadFile,
	resolveLocalTransferPath,
	resolveRemoteTransferPath,
	type TransferResult,
	uploadFile,
} from "./file-transfer.ts";
import { buildRemoteCommand, parseSshConfig, type ResolvedSshTarget } from "./protocol.ts";
import { RootShell } from "./root-shell.ts";
import { renderSshCall, renderSshResult } from "./ui.ts";

const SSH_PATH = "ssh";

const ToolParameters = Type.Object({
	action: StringEnum(
		["exec", "sudo_exec", "upload", "download", "bg_start", "bg_status", "bg_wait", "bg_kill", "list", "close"] as const,
		{ description: "SSH session operation" },
	),
	command: Type.Optional(Type.String({ description: "Non-interactive remote shell command for exec, sudo_exec, or bg_start" })),
	cwd: Type.Optional(Type.String({ description: "Absolute remote working directory; defaults to the connected session directory" })),
	local_path: Type.Optional(Type.String({ description: "Local file path for upload or download; relative paths use Pi's current working directory" })),
	remote_path: Type.Optional(Type.String({ description: "Remote file path for upload or download; relative paths use cwd" })),
	overwrite: Type.Optional(Type.Boolean({ description: "Allow an existing destination file to be atomically replaced; defaults to false" })),
	mode: Type.Optional(Type.Integer({ minimum: 0, maximum: 0o777, description: "Optional remote permission mode for upload, as an integer (for example 493 for 0755)" })),
	title: Type.Optional(Type.String({ description: "Short title for bg_start" })),
	job_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32 })),
	timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
});

interface ActiveSession {
	readonly target: ResolvedSshTarget;
	readonly client: Client;
	readonly remoteCwd: string;
	manager: BackgroundProcessManager;
	backgroundOutputs: BackgroundOutputRegistry;
	rootShell?: RootShell;
	closing: boolean;
}

export default function sshSessionExtension(pi: ExtensionAPI) {
	let session: ActiveSession | undefined;
	let latestContext: ExtensionContext | undefined;

	const setStatus = (ctx: ExtensionContext) => {
		latestContext = ctx;
		ctx.ui.setStatus(
			"ssh-session",
			session
				? `SSH: ${session.target.user}@${session.target.requested}${session.rootShell ? " • root" : ""}`
				: undefined,
		);
	};

	const announce = (content: string) => {
		pi.sendMessage(
			{ customType: "ssh-session-state", content, display: true },
			{ deliverAs: "nextTurn" },
		);
	};

	const connect = async (rawTarget: string, ctx: ExtensionCommandContext) => {
		await ctx.waitForIdle();
		if (session) throw new Error(`Already connected to ${session.target.user}@${session.target.requested}; disconnect first`);
		if (ctx.mode !== "tui") {
			throw new Error("/ssh-connect currently requires Pi's TUI for masked password and sudo prompts");
		}

		const requested = validateTarget(rawTarget);
		const target = resolveTarget(requested);
		const addresses = await resolveAddresses(target.hostName);
		const knownFingerprints = getKnownFingerprints(target);
		const approved = await ctx.ui.confirm(
			"Authorize persistent SSH connection?",
			[
				`Requested: ${requested}`,
				`User: ${target.user}`,
				`Host: ${target.hostName}`,
				`Port: ${target.port}`,
				`Resolved address: ${addresses.join(", ") || "unavailable"}`,
				`Known host fingerprint: ${knownFingerprints.join(", ") || "unknown — the negotiated fingerprint will require confirmation"}`,
			].join("\n"),
		);
		if (!approved) return;

		const privilege = await ctx.ui.select("Agent privilege for this SSH session", [
			"Normal commands only",
			"Unrestricted root until disconnect",
		]);
		if (!privilege) return;
		if (privilege === "Unrestricted root until disconnect") {
			const rootApproved = await ctx.ui.confirm(
				"Grant unrestricted root access?",
				`The agent may run any command as root on ${target.user}@${target.hostName} without further confirmation until this SSH session closes.`,
			);
			if (!rootApproved) return;
		}

		const client = await connectClient(ctx, target, knownFingerprints);
		try {
			const operations = createRemoteOperations(client);
			const pwd = await captureExec(operations, "pwd", ".", 15_000);
			if (pwd.exitCode !== 0) throw new Error(`Could not determine remote working directory: ${pwd.output.text.trim()}`);
			const remoteCwd = pwd.output.text.trim().split(/\r?\n/u).at(-1);
			if (!remoteCwd?.startsWith("/")) throw new Error(`Remote pwd returned an invalid directory: ${remoteCwd ?? ""}`);

			const backgroundOutputs = new BackgroundOutputRegistry(operations);
			const manager = new BackgroundProcessManager(backgroundOutputs.operations, {
				maxRunning: 8,
				maxEntries: 32,
				maxOutputBytes: 1024 * 1024,
				persistFullOutput: false,
			});
			manager.subscribe((event) => {
				if (event.kind === "pruned") backgroundOutputs.forget(event.id);
			});
			session = {
				target,
				client,
				remoteCwd,
				manager,
				backgroundOutputs,
				closing: false,
			};

			client.on("close", () => {
				if (!session || session.client !== client || session.closing) return;
				const lost = session;
				session = undefined;
				void lost.manager.dispose(1000);
				if (latestContext) {
					setStatus(latestContext);
					latestContext.ui.notify(`SSH connection to ${target.user}@${target.hostName} closed`, "warning");
				}
			});

			if (privilege === "Unrestricted root until disconnect") {
				session.rootShell = await RootShell.start(ctx, client);
			}
			setStatus(ctx);
			announce(
				`The user authorized SSH access to ${target.user}@${target.hostName} (${remoteCwd}). ` +
				(session.rootShell
					? "The ssh_session tool may run normal and unrestricted root commands until disconnect."
					: "The ssh_session tool may run normal commands; root access was not authorized."),
			);
			ctx.ui.notify(`Connected to ${target.user}@${target.hostName}${session.rootShell ? " with session root access" : ""}`, "info");
		} catch (error) {
			if (session) await closeSession(session);
			else client.end();
			session = undefined;
			throw error;
		}
	};

	pi.registerCommand("ssh-connect", {
		description: "Open a user-authorized persistent SSH session: /ssh-connect user@host",
		handler: async (args, ctx) => {
			try {
				await connect(args, ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("ssh-disconnect", {
		description: "Close the active persistent SSH session",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			if (!session) {
				ctx.ui.notify("No SSH session is connected", "info");
				return;
			}
			const target = `${session.target.user}@${session.target.hostName}`;
			const active = session;
			session = undefined;
			await closeSession(active);
			setStatus(ctx);
			announce(`The user closed the SSH session to ${target}. The ssh_session tool is no longer authorized.`);
			ctx.ui.notify(`Disconnected from ${target}`, "info");
		},
	});

	pi.registerCommand("ssh-status", {
		description: "Show the active SSH connection and background jobs",
		handler: async (_args, ctx) => {
			ctx.ui.notify(session ? formatSession(session, true) : "No SSH session is connected", "info");
		},
	});

	pi.registerTool({
		name: "ssh_session",
		label: "SSH session",
		description:
			"Operate on an existing user-authorized persistent SSH session. This tool cannot establish connections; the user must invoke /ssh-connect. Actions: exec and sudo_exec run foreground commands; upload and download atomically transfer individual regular files over the authenticated SFTP channel; bg_start, bg_status, bg_wait, and bg_kill manage non-privileged background jobs; list reports state; close disconnects. sudo_exec is available only when the user granted unrestricted root access for the session. Command output is limited to 2000 lines or 50KB; complete output is saved to a local temp file when truncated.",
		parameters: ToolParameters,
		renderCall(args, theme, context) {
			return renderSshCall(args, theme, context.expanded, context.lastComponent as Text | undefined);
		},
		renderResult(result, options, theme, context) {
			return renderSshResult(
				result,
				options,
				theme,
				context.lastComponent as Text | undefined,
				context.isError,
			);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			latestContext = ctx;
			if (params.action === "list") {
				return textResult(session ? formatSession(session, true) : "No user-authorized SSH session is connected.", { action: "list" });
			}
			const active = requireSession(session);
			if (active.closing) throw new Error("The SSH session is closing");
			const cwd = validateRemoteCwd(params.cwd ?? active.remoteCwd);

			switch (params.action) {
				case "exec": {
					const command = requireCommand(params.command);
					const result = await runCapturedCommand(
						createRemoteOperations(active.client),
						command,
						cwd,
						params.timeout_seconds,
						signal,
						(text) => onUpdate?.({ content: [{ type: "text", text }], details: { running: true } }),
						"exec",
					);
					return commandResult("exec", result.exitCode, result.output, false);
				}
				case "sudo_exec": {
					const command = requireCommand(params.command);
					if (!active.rootShell) {
						throw new Error("The user did not grant root access for this SSH session; reconnect and select unrestricted root access");
					}
					const capture = new CommandOutputCapture("sudo-exec");
					try {
						const result = await active.rootShell.execute(command, cwd, {
							signal,
							timeoutMs: params.timeout_seconds === undefined ? undefined : params.timeout_seconds * 1000,
							onData: (chunk) => capture.append(chunk),
						});
						return commandResult("sudo_exec", result.exitCode, capture.finish(), true);
					} catch (error) {
						throw enrichCaptureError(error, capture.finish());
					}
				}
				case "upload": {
					const localPath = resolveLocalTransferPath(requirePath(params.local_path, "local_path"), ctx.cwd);
					const remotePath = resolveRemoteTransferPath(requirePath(params.remote_path, "remote_path"), cwd);
					const result = await uploadFile({
						client: active.client,
						localPath,
						remotePath,
						overwrite: params.overwrite ?? false,
						mode: params.mode,
						signal,
						timeoutMs: params.timeout_seconds === undefined ? undefined : params.timeout_seconds * 1000,
						onProgress: (text, transferredBytes, totalBytes) =>
							onUpdate?.({ content: [{ type: "text", text }], details: { running: true, transferredBytes, totalBytes } }),
					});
					return transferResult("upload", result);
				}
				case "download": {
					const localPath = resolveLocalTransferPath(requirePath(params.local_path, "local_path"), ctx.cwd);
					const remotePath = resolveRemoteTransferPath(requirePath(params.remote_path, "remote_path"), cwd);
					const result = await downloadFile({
						client: active.client,
						localPath,
						remotePath,
						overwrite: params.overwrite ?? false,
						signal,
						timeoutMs: params.timeout_seconds === undefined ? undefined : params.timeout_seconds * 1000,
						onProgress: (text, transferredBytes, totalBytes) =>
							onUpdate?.({ content: [{ type: "text", text }], details: { running: true, transferredBytes, totalBytes } }),
					});
					return transferResult("download", result);
				}
				case "bg_start": {
					if (signal?.aborted) throw new Error("Background start aborted before launch");
					const command = requireCommand(params.command);
					const title = (params.title?.trim() || command).slice(0, 80);
					const started = active.manager.start(command, title, cwd);
					active.backgroundOutputs.claim(started.id);
					return textResult(`Started ${started.id}: ${title}\nHost: ${active.target.user}@${active.target.hostName}\nCWD: ${cwd}`, {
						action: "bg_start",
						jobId: started.id,
					});
				}
				case "bg_status": {
					const ids = requireJobIds(params.job_ids);
					const outputs = ids.map((id) => active.backgroundOutputs.get(id));
					const outputPaths = ids.map((id) => active.backgroundOutputs.getPath(id));
					return textResult(
						ids.map((id, index) => formatJob(active.manager.get(id, true), true, outputs[index], outputPaths[index])).join("\n\n"),
						{
							action: "bg_status",
							jobIds: ids,
							fullOutputPaths: outputPaths.filter((path): path is string => Boolean(path)),
						},
					);
				}
				case "bg_wait": {
					const ids = requireJobIds(params.job_ids);
					const waited = await active.manager.wait(ids, {
						timeoutMs: params.timeout_seconds === undefined ? undefined : params.timeout_seconds * 1000,
						signal,
						onUpdate: (runningIds) =>
							onUpdate?.({ content: [{ type: "text", text: `Still running: ${runningIds.join(", ")}` }], details: { runningIds } }),
					});
					const settled = waited.settled
						.map((item) => formatJob(item, true, active.backgroundOutputs.get(item.id), active.backgroundOutputs.getPath(item.id)))
						.join("\n\n");
					const fullOutputPaths = waited.settled.flatMap((item) => {
						const path = active.backgroundOutputs.get(item.id)?.fullOutputPath;
						return path ? [path] : [];
					});
					return textResult(
						[settled || "No selected jobs settled.", waited.runningIds.length ? `Still running: ${waited.runningIds.join(", ")}` : ""].filter(Boolean).join("\n\n"),
						{ action: "bg_wait", jobIds: ids, runningIds: waited.runningIds, fullOutputPaths },
					);
				}
				case "bg_kill": {
					const ids = requireJobIds(params.job_ids);
					const killed = await active.manager.kill(ids);
					return textResult(killed.map((item) => `${item.id}: ${item.outcome}`).join("\n"), {
						action: "bg_kill",
						jobIds: ids,
					});
				}
				case "close": {
					const target = `${active.target.user}@${active.target.hostName}`;
					session = undefined;
					await closeSession(active);
					setStatus(ctx);
					return textResult(`Closed SSH session to ${target}.`, { action: "close" });
				}
			}
		},
	});

	pi.on("session_start", (_event, ctx) => setStatus(ctx));

	pi.on("session_shutdown", async (_event, ctx) => {
		latestContext = ctx;
		const active = session;
		session = undefined;
		if (active) await closeSession(active);
		ctx.ui.setStatus("ssh-session", undefined);
	});
}

async function connectClient(
	ctx: ExtensionCommandContext,
	target: ResolvedSshTarget,
	knownFingerprints: string[],
): Promise<Client> {
	const { Client } = await import("ssh2");
	const client = new Client();
	let authenticationCancelled = false;
	let passwordAttempted = false;

	return new Promise<Client>((resolve, reject) => {
		let settled = false;
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			client.end();
			reject(error);
		};
		client.once("ready", () => {
			if (settled) return;
			settled = true;
			resolve(client);
		});
		client.on("error", (error) => {
			fail(authenticationCancelled ? new Error("SSH authentication cancelled") : error);
		});

		client.connect({
			host: target.hostName,
			port: target.port,
			username: target.user,
			readyTimeout: 30_000,
			keepaliveInterval: 30_000,
			keepaliveCountMax: 3,
			hostVerifier(key, verify) {
				const actual = fingerprintHostKey(key);
				if (knownFingerprints.length > 0) {
					if (knownFingerprints.includes(actual)) verify(true);
					else {
						verify(false);
						fail(
							new Error(
								`SSH HOST KEY MISMATCH for ${target.hostName}. Expected ${knownFingerprints.join(", ")}; received ${actual}.`,
							),
						);
					}
					return;
				}
				void ctx.ui
					.confirm(
						"Unknown SSH host key",
						`Host: ${target.hostName}:${target.port}\nFingerprint: ${actual}\n\nTrust this negotiated key for this session?`,
					)
					.then((approved) => verify(approved), () => verify(false));
			},
			authHandler(methodsLeft, _partialSuccess, callback) {
				if (passwordAttempted || (methodsLeft && !methodsLeft.includes("password"))) {
					callback(false);
					return;
				}
				passwordAttempted = true;
				void promptSecret(ctx, `Password for ${target.user}@${target.hostName}`)
					.then((password) => {
						if (password === undefined) {
							authenticationCancelled = true;
							callback(false);
							return;
						}
						callback({ type: "password", username: target.user, password });
					})
					.catch(() => {
						authenticationCancelled = true;
						callback(false);
					});
			},
		});
	});
}

async function promptSecret(ctx: ExtensionCommandContext, title: string): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		let characters: string[] = [];
		let finished = false;
		const finish = (value: string | undefined) => {
			if (finished) return;
			finished = true;
			characters.fill("");
			characters = [];
			done(value);
		};

		return {
			render(width: number) {
				return [
					truncateToWidth(theme.fg("accent", theme.bold(title)), width),
					truncateToWidth(`Password: ${"•".repeat(characters.length)}`, width),
					truncateToWidth(theme.fg("dim", "Enter confirms • Esc cancels • value is never sent to the model"), width),
				];
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.enter)) {
					const value = characters.join("");
					finish(value);
					return;
				}
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
					finish(undefined);
					return;
				}
				if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
					characters.pop();
					tui.requestRender();
					return;
				}
				const bracketedPaste = data.includes("\x1b[200~") || data.includes("\x1b[201~");
				if (bracketedPaste) data = data.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "");
				else if (data.startsWith("\x1b")) return;
				for (const character of data) {
					const code = character.codePointAt(0) ?? 0;
					if (code >= 32 && code !== 127) characters.push(character);
				}
				tui.requestRender();
			},
		};
	});
}

function fingerprintHostKey(key: Buffer): string {
	return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/u, "")}`;
}

function validateTarget(value: string): string {
	const target = value.trim();
	if (!target || /\s/u.test(target) || target.startsWith("-")) {
		throw new Error("Usage: /ssh-connect user@host");
	}
	return target;
}

function resolveTarget(requested: string): ResolvedSshTarget {
	const result = spawnSync(SSH_PATH, ["-G", requested], { encoding: "utf8", windowsHide: true });
	if (result.status !== 0) throw new Error((result.stderr || "Could not resolve OpenSSH configuration").trim());
	return parseSshConfig(requested, result.stdout);
}

async function resolveAddresses(hostName: string): Promise<string[]> {
	try {
		return [...new Set((await lookup(hostName, { all: true })).map((item) => item.address))];
	} catch {
		return [];
	}
}

function getKnownFingerprints(target: ResolvedSshTarget): string[] {
	const requestedHost = target.requested.includes("@") ? target.requested.slice(target.requested.lastIndexOf("@") + 1) : target.requested;
	const hosts = new Set([requestedHost, target.hostName]);
	const fingerprints = new Set<string>();
	for (const candidate of hosts) {
		const host = target.port === 22 ? candidate : `[${candidate}]:${target.port}`;
		const found = spawnSync("ssh-keygen", ["-F", host], { encoding: "utf8", windowsHide: true });
		if (found.status !== 0 || !found.stdout.trim()) continue;
		for (const line of found.stdout.split(/\r?\n/u)) {
			if (!line || line.startsWith("#")) continue;
			const key = line.split(/\s+/u).slice(1).join(" ");
			if (!key) continue;
			const result = spawnSync("ssh-keygen", ["-lf", "-"], { input: `${key}\n`, encoding: "utf8", windowsHide: true });
			if (result.status === 0) {
				const match = result.stdout.match(/\b(SHA256:[A-Za-z0-9+/=]+)/u);
				if (match) fingerprints.add(match[1].replace(/=+$/u, ""));
			}
		}
	}
	return [...fingerprints];
}

function createRemoteOperations(client: Client): BashOperations {
	return {
		exec(command, cwd, { onData, signal, timeout }) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}
				client.exec(buildRemoteCommand(command, cwd), (openError, channel) => {
					if (openError) {
						reject(openError);
						return;
					}
					let settled = false;
					let exitCode: number | null = null;
					let timedOut = false;
					const finish = (error?: Error) => {
						if (settled) return;
						settled = true;
						if (timer) clearTimeout(timer);
						signal?.removeEventListener("abort", onAbort);
						if (error) reject(error);
						else resolve({ exitCode });
					};
					const onAbort = () => {
						try {
							channel.signal("INT");
						} catch {}
						channel.close();
						finish(new Error("aborted"));
					};
					const timer = timeout
						? setTimeout(() => {
								timedOut = true;
								try {
									channel.signal("TERM");
								} catch {}
								channel.close();
								finish(new Error(`timeout:${timeout}`));
							}, timeout * 1000)
						: undefined;
					const handleData = (chunk: Buffer) => {
						try {
							onData(chunk);
						} catch (error) {
							channel.close();
							finish(error instanceof Error ? error : new Error(String(error)));
						}
					};
					channel.on("data", handleData);
					channel.stderr.on("data", handleData);
					channel.on("exit", (code: number | null) => {
						exitCode = code;
					});
					channel.on("error", (error: Error) => finish(error));
					channel.on("close", () => {
						if (timedOut) finish(new Error(`timeout:${timeout}`));
						else if (signal?.aborted) finish(new Error("aborted"));
						else finish();
					});
					signal?.addEventListener("abort", onAbort, { once: true });
					if (signal?.aborted) onAbort();
				});
			});
		},
	};
}

async function captureExec(operations: BashOperations, command: string, cwd: string, timeoutMs: number) {
	const output = new TailBuffer(50 * 1024);
	const result = await operations.exec(command, cwd, {
		onData: (chunk) => output.append(chunk),
		timeout: Math.ceil(timeoutMs / 1000),
	});
	return { exitCode: result.exitCode ?? 255, output: output.snapshot() };
}

async function runCapturedCommand(
	operations: BashOperations,
	command: string,
	cwd: string,
	timeoutSeconds: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: (text: string) => void,
	label: string,
) {
	const capture = new CommandOutputCapture(label);
	let lastUpdate = 0;
	try {
		const result = await operations.exec(command, cwd, {
			signal,
			timeout: timeoutSeconds,
			onData: (chunk) => {
				capture.append(chunk);
				if (Date.now() - lastUpdate > 250) {
					lastUpdate = Date.now();
					onUpdate(capture.preview());
				}
			},
		});
		return { exitCode: result.exitCode ?? 255, output: capture.finish() };
	} catch (error) {
		throw enrichCaptureError(error, capture.finish());
	}
}

interface BackgroundCaptureRecord {
	readonly capture: CommandOutputCapture;
	output?: CapturedOutput;
}

class BackgroundOutputRegistry {
	private readonly unclaimed: BackgroundCaptureRecord[] = [];
	private readonly records = new Map<string, BackgroundCaptureRecord>();
	readonly operations: BashOperations;

	constructor(base: BashOperations) {
		this.operations = {
			exec: (command, cwd, options) => {
				const record: BackgroundCaptureRecord = { capture: new CommandOutputCapture("background") };
				this.unclaimed.push(record);
				let execution: ReturnType<BashOperations["exec"]>;
				try {
					execution = base.exec(command, cwd, {
						...options,
						onData: (chunk) => {
							record.capture.append(chunk);
							options.onData(chunk);
						},
					});
				} catch (error) {
					record.output = record.capture.finish();
					throw error;
				}
				return execution.then(
					(result) => {
						record.output = record.capture.finish();
						return result;
					},
					(error) => {
						record.output = record.capture.finish();
						throw error;
					},
				);
			},
		};
	}

	claim(id: string): void {
		const record = this.unclaimed.shift();
		if (record) this.records.set(id, record);
	}

	get(id: string): CapturedOutput | undefined {
		return this.records.get(id)?.output;
	}

	getPath(id: string): string | undefined {
		const record = this.records.get(id);
		return record?.output?.fullOutputPath ?? record?.capture.dumpPathIfLarge;
	}

	forget(id: string): void {
		this.records.delete(id);
	}
}

function validateRemoteCwd(cwd: string): string {
	const value = cwd.trim();
	if (!value.startsWith("/") || value.includes("\0")) throw new Error("cwd must be an absolute remote POSIX path");
	return value;
}

function requireCommand(command: string | undefined): string {
	const value = command?.trim();
	if (!value) throw new Error("This action requires a non-empty command");
	return value;
}

function requirePath(path: string | undefined, name: "local_path" | "remote_path"): string {
	if (path === undefined) throw new Error(`This action requires ${name}`);
	return path;
}

function requireJobIds(ids: string[] | undefined): string[] {
	if (!ids?.length) throw new Error("This action requires job_ids");
	return ids;
}

function requireSession(session: ActiveSession | undefined): ActiveSession {
	if (!session) throw new Error("No user-authorized SSH session is connected. The user must run /ssh-connect user@host.");
	return session;
}

function commandResult(action: "exec" | "sudo_exec", exitCode: number, output: CapturedOutput, privileged: boolean) {
	return {
		content: [{ type: "text" as const, text: `${formatCapturedOutput(output)}\n\nExit code: ${exitCode}${privileged ? " (root)" : ""}` }],
		details: {
			action,
			exitCode,
			privileged,
			totalBytes: output.totalBytes,
			totalLines: output.totalLines,
			outputBytes: output.outputBytes,
			outputLines: output.outputLines,
			truncated: output.truncated,
			fullOutputPath: output.fullOutputPath,
		},
	};
}

function transferResult(action: "upload" | "download", result: TransferResult) {
	const verb = action === "upload" ? "Uploaded" : "Downloaded";
	return {
		content: [{
			type: "text" as const,
			text: [
				`${verb} ${formatTransferBytes(result.bytes)} in ${formatTransferDuration(result.elapsedMs)}`,
				`Local: ${result.localPath}`,
				`Remote: ${result.remotePath}`,
				`SHA-256: ${result.sha256}`,
				`Remote mode: ${result.remoteMode.toString(8).padStart(4, "0")}`,
			].join("\n"),
		}],
		details: { action, ...result },
	};
}

function formatTransferBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function formatTransferDuration(milliseconds: number): string {
	return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function formatSession(session: ActiveSession, includeJobs: boolean): string {
	const lines = [
		`Target: ${session.target.user}@${session.target.hostName}:${session.target.port}`,
		`CWD: ${session.remoteCwd}`,
		`Root access: ${session.rootShell ? "authorized until disconnect" : "not authorized"}`,
	];
	if (includeJobs) {
		const jobs = session.manager.list();
		lines.push(jobs.length ? `Jobs:\n${jobs.map((job) => formatJob(job, false, session.backgroundOutputs.get(job.id))).join("\n")}` : "Jobs: none");
	}
	return lines.join("\n");
}

function formatJob(job: BackgroundProcessSnapshot, includeOutput: boolean, output?: CapturedOutput, liveOutputPath?: string): string {
	const lines = [`${job.id} [${job.status}] ${job.title}`, `CWD: ${job.cwd}`];
	if (job.exitCode !== undefined) lines.push(`Exit code: ${job.exitCode ?? "unknown"}`);
	if (job.errorText) lines.push(`Error: ${job.errorText}`);
	if (includeOutput) {
		lines.push(output ? formatCapturedOutput(output) : formatTailPreview(job.output));
		if (!output && liveOutputPath) lines.push(`Full output currently streaming to: ${liveOutputPath}`);
	}
	return lines.join("\n");
}

function enrichCaptureError(error: unknown, output: CapturedOutput): Error {
	const message = error instanceof Error ? error.message : String(error);
	if (!output.fullOutputPath) return error instanceof Error ? error : new Error(message);
	return new Error(`${message}\nFull command output saved to: ${output.fullOutputPath}`);
}

async function closeSession(session: ActiveSession): Promise<void> {
	if (session.closing) return;
	session.closing = true;
	await session.manager.dispose(5000);
	await session.rootShell?.close();
	try {
		await captureExec(createRemoteOperations(session.client), "sudo -k", session.remoteCwd, 5000);
	} catch {
		// Best effort: the connection may already have failed.
	}
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, 1000);
		session.client.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
		session.client.end();
	});
}
