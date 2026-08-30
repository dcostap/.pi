import { randomBytes } from "node:crypto";
import { closeSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

const RETAINED_BYTES = 64 * 1024;

export interface TodoOutputSnapshot {
	text: string;
	totalBytes: number;
	totalLines: number;
	truncated: boolean;
	fullOutputPath?: string;
}

export class TodoOutputCapture {
	private retained = Buffer.alloc(0);
	private readonly pending: Buffer[] = [];
	private totalBytes = 0;
	private newlineCount = 0;
	private hasOutput = false;
	private endsWithNewline = false;
	private path: string | undefined;
	private fd: number | undefined;
	private fileError = false;

	append(chunk: Buffer): void {
		if (chunk.length === 0) return;
		this.totalBytes += chunk.length;
		this.hasOutput = true;
		for (const byte of chunk) if (byte === 10) this.newlineCount++;
		this.endsWithNewline = chunk[chunk.length - 1] === 10;
		this.retained = Buffer.concat([this.retained, chunk]);
		if (this.retained.length > RETAINED_BYTES) this.retained = this.retained.subarray(this.retained.length - RETAINED_BYTES);

		if (this.fd === undefined && !this.fileError) {
			this.pending.push(Buffer.from(chunk));
			if (this.exceedsInlineLimit()) this.openFile();
			return;
		}
		if (this.fd !== undefined) this.write(chunk);
	}

	finish(): TodoOutputSnapshot {
		if (this.exceedsInlineLimit() && this.fd === undefined && !this.fileError) this.openFile();
		this.closeFile();
		this.pending.length = 0;
		if (!this.exceedsInlineLimit() && this.path) {
			try { rmSync(this.path, { force: true }); } catch {}
			this.path = undefined;
		}
		return {
			text: this.retained.toString("utf8"),
			totalBytes: this.totalBytes,
			totalLines: this.totalLines,
			truncated: this.exceedsInlineLimit() || this.totalBytes > this.retained.length,
			fullOutputPath: this.exceedsInlineLimit() && !this.fileError ? this.path : undefined,
		};
	}

	private get totalLines(): number {
		return this.newlineCount + (this.hasOutput && !this.endsWithNewline ? 1 : 0);
	}

	private exceedsInlineLimit(): boolean {
		return this.totalBytes > DEFAULT_MAX_BYTES || this.totalLines > DEFAULT_MAX_LINES;
	}

	private openFile(): void {
		try {
			this.path = join(tmpdir(), `pi-todo-watch-${randomBytes(8).toString("hex")}.log`);
			this.fd = openSync(this.path, "wx", 0o600);
			for (const chunk of this.pending) this.write(chunk);
			this.pending.length = 0;
		} catch {
			this.fileError = true;
			this.closeFile();
			if (this.path) {
				try { rmSync(this.path, { force: true }); } catch {}
			}
			this.path = undefined;
		}
	}

	private write(chunk: Buffer): void {
		if (this.fd === undefined) return;
		try {
			let offset = 0;
			while (offset < chunk.length) offset += writeSync(this.fd, chunk, offset, chunk.length - offset);
		} catch {
			this.fileError = true;
			this.closeFile();
		}
	}

	private closeFile(): void {
		if (this.fd === undefined) return;
		try { closeSync(this.fd); } catch { this.fileError = true; }
		this.fd = undefined;
	}
}
