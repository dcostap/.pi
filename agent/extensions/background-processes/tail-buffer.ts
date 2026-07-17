export interface TailBufferSnapshot {
	readonly text: string;
	readonly totalBytes: number;
	readonly retainedBytes: number;
	readonly droppedBytes: number;
	readonly truncated: boolean;
	readonly version: number;
}

/** A raw-byte tail with a strict logical and backing-buffer cap. */
export class TailBuffer {
	private chunks: Buffer[] = [];
	private retainedBytes = 0;
	private totalBytes = 0;
	private currentVersion = 0;
	private cachedSnapshot: TailBufferSnapshot | undefined;

	constructor(readonly maxBytes = 1024 * 1024) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
			throw new Error("TailBuffer maxBytes must be a positive safe integer");
		}
	}

	append(data: Buffer): void {
		if (data.length === 0) return;

		this.totalBytes += data.length;
		this.currentVersion++;
		this.cachedSnapshot = undefined;

		if (data.length >= this.maxBytes) {
			this.chunks = [Buffer.from(data.subarray(data.length - this.maxBytes))];
			this.retainedBytes = this.maxBytes;
			return;
		}

		this.chunks.push(Buffer.from(data));
		this.retainedBytes += data.length;
		this.trim();
	}

	snapshot(): TailBufferSnapshot {
		if (this.cachedSnapshot) return this.cachedSnapshot;
		const bytes = this.chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(this.chunks, this.retainedBytes);
		this.cachedSnapshot = {
			text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
			totalBytes: this.totalBytes,
			retainedBytes: this.retainedBytes,
			droppedBytes: this.totalBytes - this.retainedBytes,
			truncated: this.totalBytes > this.retainedBytes,
			version: this.currentVersion,
		};
		return this.cachedSnapshot;
	}

	get version(): number {
		return this.currentVersion;
	}

	private trim(): void {
		let excess = this.retainedBytes - this.maxBytes;
		while (excess > 0 && this.chunks.length > 0) {
			const first = this.chunks[0]!;
			if (first.length <= excess) {
				this.chunks.shift();
				this.retainedBytes -= first.length;
				excess -= first.length;
				continue;
			}

			// Copy the remainder so an evicted prefix cannot stay alive through a slice.
			this.chunks[0] = Buffer.from(first.subarray(excess));
			this.retainedBytes -= excess;
			excess = 0;
		}
	}
}
