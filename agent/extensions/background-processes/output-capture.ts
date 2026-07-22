import { randomBytes } from "node:crypto";
import { closeSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { TailBuffer, type TailBufferSnapshot } from "./tail-buffer.ts";

export interface BackgroundOutputSnapshot extends TailBufferSnapshot {
	readonly totalLines: number;
	readonly fullOutputPath?: string;
	readonly fileError?: string;
}

/** Retains a bounded in-memory tail while streaming the complete output to a temporary file. */
export class BackgroundOutputCapture {
	private readonly tail: TailBuffer;
	private readonly rawChunks: Buffer[] = [];
	private path: string | undefined;
	private fd: number | undefined;
	private newlineCount = 0;
	private hasOutput = false;
	private endsWithNewline = false;
	private finished = false;
	private fileError: string | undefined;

	constructor(
		maxRetainedBytes = 1024 * 1024,
		private readonly persistFullOutput = true,
	) {
		this.tail = new TailBuffer(maxRetainedBytes);
	}

	append(data: Buffer): void {
		if (this.finished || data.length === 0) return;
		this.tail.append(data);
		this.hasOutput = true;
		for (const byte of data) if (byte === 10) this.newlineCount++;
		this.endsWithNewline = data[data.length - 1] === 10;
		if (!this.persistFullOutput) return;

		if (this.fd === undefined && !this.fileError) {
			this.rawChunks.push(Buffer.from(data));
			if (this.exceedsInlineLimit()) this.openFile();
			return;
		}
		if (this.fd === undefined) return;
		try {
			this.write(data);
		} catch (error) {
			this.fileError = error instanceof Error ? error.message : String(error);
			this.closeFile();
			try {
				if (this.path) rmSync(this.path, { force: true });
			} catch {
				// The in-memory tail remains usable even if temporary-file cleanup fails.
			}
		}
	}

	finish(): void {
		if (this.finished) return;
		this.finished = true;
		if (!this.persistFullOutput) return;
		if (this.exceedsInlineLimit() && this.fd === undefined && !this.fileError) this.openFile();
		this.closeFile();
		this.rawChunks.length = 0;
		if ((!this.exceedsInlineLimit() || this.fileError) && this.path) {
			try {
				rmSync(this.path, { force: true });
			} catch {
				// Best-effort cleanup of output that did not need to be persisted.
			}
		}
	}

	snapshot(): BackgroundOutputSnapshot {
		const tail = this.tail.snapshot();
		return {
			...tail,
			totalLines: this.totalLines,
			fullOutputPath: this.persistFullOutput && this.exceedsInlineLimit() && !this.fileError ? this.path : undefined,
			fileError: this.persistFullOutput && this.exceedsInlineLimit() ? this.fileError : undefined,
		};
	}

	private get totalLines(): number {
		return this.newlineCount + (this.hasOutput && !this.endsWithNewline ? 1 : 0);
	}

	private exceedsInlineLimit(): boolean {
		return this.tail.snapshot().totalBytes > DEFAULT_MAX_BYTES || this.totalLines > DEFAULT_MAX_LINES;
	}

	private openFile(): void {
		try {
			this.path = join(tmpdir(), `pi-bash-bg-${randomBytes(8).toString("hex")}.log`);
			this.fd = openSync(this.path, "wx", 0o600);
			for (const chunk of this.rawChunks) this.write(chunk);
			this.rawChunks.length = 0;
		} catch (error) {
			this.fileError = error instanceof Error ? error.message : String(error);
			this.closeFile();
			try {
				if (this.path) rmSync(this.path, { force: true });
			} catch {
				// The in-memory tail remains usable even if temporary-file cleanup fails.
			}
		}
	}

	private write(data: Buffer): void {
		if (this.fd === undefined) return;
		let offset = 0;
		while (offset < data.length) offset += writeSync(this.fd, data, offset, data.length - offset);
	}

	private closeFile(): void {
		if (this.fd === undefined) return;
		try {
			closeSync(this.fd);
		} catch (error) {
			this.fileError ??= error instanceof Error ? error.message : String(error);
		} finally {
			this.fd = undefined;
		}
	}
}
