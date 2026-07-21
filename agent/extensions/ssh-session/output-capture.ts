import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { TailBuffer, type TailBufferSnapshot } from "../background-processes/tail-buffer.ts";
import { sanitizeTerminalText } from "./protocol.ts";

const OUTPUT_DIRECTORY = join(tmpdir(), "pi-ssh-session-output");
const INLINE_TAIL_BYTES = DEFAULT_MAX_BYTES;

export interface CapturedOutput {
	readonly text: string;
	readonly totalBytes: number;
	readonly totalLines: number;
	readonly outputBytes: number;
	readonly outputLines: number;
	readonly truncated: boolean;
	readonly fullOutputPath?: string;
}

/** Streams complete merged command output to disk while retaining only a bounded inline tail. */
export class CommandOutputCapture {
	private readonly tail = new TailBuffer(INLINE_TAIL_BYTES);
	private readonly path: string;
	private fd: number | undefined;
	private totalBytes = 0;
	private newlineCount = 0;
	private finished?: CapturedOutput;

	constructor(label: string) {
		mkdirSync(OUTPUT_DIRECTORY, { recursive: true, mode: 0o700 });
		const safeLabel = label.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40) || "command";
		this.path = join(OUTPUT_DIRECTORY, `${new Date().toISOString().replace(/[:.]/gu, "-")}_${safeLabel}_${randomUUID()}.log`);
		this.fd = openSync(this.path, "wx", 0o600);
	}

	append(chunk: Buffer): void {
		if (this.fd === undefined || chunk.length === 0) return;
		let offset = 0;
		while (offset < chunk.length) {
			offset += writeSync(this.fd, chunk, offset, chunk.length - offset);
		}
		this.tail.append(chunk);
		this.totalBytes += chunk.length;
		for (const byte of chunk) if (byte === 10) this.newlineCount++;
	}

	preview(): string {
		const snapshot = this.tail.snapshot();
		const truncated = truncateTail(sanitizeTerminalText(snapshot.text), {
			maxBytes: DEFAULT_MAX_BYTES,
			maxLines: DEFAULT_MAX_LINES,
		});
		return truncated.content || "(no output yet)";
	}

	get dumpPathIfLarge(): string | undefined {
		const totalLines = this.totalBytes === 0 ? 0 : this.newlineCount + 1;
		return this.totalBytes > DEFAULT_MAX_BYTES || totalLines > DEFAULT_MAX_LINES ? this.path : undefined;
	}

	finish(): CapturedOutput {
		if (this.finished) return this.finished;
		if (this.fd !== undefined) {
			closeSync(this.fd);
			this.fd = undefined;
		}

		const snapshot = this.tail.snapshot();
		const bounded = truncateTail(sanitizeTerminalText(snapshot.text), {
			maxBytes: DEFAULT_MAX_BYTES,
			maxLines: DEFAULT_MAX_LINES,
		});
		const totalLines = this.totalBytes === 0 ? 0 : this.newlineCount + 1;
		const wasTruncated = snapshot.truncated || bounded.truncated || totalLines > bounded.outputLines;
		if (!wasTruncated) rmSync(this.path, { force: true });

		this.finished = {
			text: bounded.content || "(no output)",
			totalBytes: this.totalBytes,
			totalLines,
			outputBytes: bounded.outputBytes,
			outputLines: bounded.outputLines,
			truncated: wasTruncated,
			fullOutputPath: wasTruncated ? this.path : undefined,
		};
		return this.finished;
	}
}

export function formatCapturedOutput(output: CapturedOutput): string {
	if (!output.truncated || !output.fullOutputPath) return output.text;
	return [
		output.text,
		"",
		`[Output truncated: showing the latest ${output.outputLines} of ${output.totalLines} lines ` +
			`(${formatSize(output.outputBytes)} of ${formatSize(output.totalBytes)}). ` +
			`Full output saved to: ${output.fullOutputPath}]`,
		"Use read with offset/limit or grep on that file to inspect the complete output.",
	].join("\n");
}

export function formatTailPreview(snapshot: TailBufferSnapshot): string {
	const bounded = truncateTail(sanitizeTerminalText(snapshot.text), {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	let text = bounded.content || "(no output yet)";
	if (snapshot.truncated || bounded.truncated) {
		text += `\n\n[Only the newest bounded output is available while this command is running.]`;
	}
	return text;
}
