import { Buffer } from "node:buffer";

export class ResponseSizeLimitError extends Error {
	readonly limitBytes: number;
	readonly observedBytes?: number;

	constructor(label: string, limitBytes: number, observedBytes?: number) {
		const observed = typeof observedBytes === "number" ? ` (observed ${observedBytes} bytes)` : "";
		super(`${label} exceeds the ${limitBytes}-byte response limit${observed}`);
		this.name = "ResponseSizeLimitError";
		this.limitBytes = limitBytes;
		this.observedBytes = observedBytes;
	}
}

function declaredContentLength(response: Response): number | undefined {
	const raw = response.headers.get("content-length");
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function readResponseBuffer(
	response: Response,
	maxBytes: number,
	label = "Response body",
	signal?: AbortSignal,
): Promise<Buffer> {
	const limit = Math.max(1, Math.floor(maxBytes));
	const declared = declaredContentLength(response);
	if (declared !== undefined && declared > limit) {
		await response.body?.cancel().catch(() => undefined);
		throw new ResponseSizeLimitError(label, limit, declared);
	}

	if (!response.body) return Buffer.alloc(0);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	try {
		while (true) {
			if (signal?.aborted) {
				await reader.cancel(signal.reason).catch(() => undefined);
				throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
			}

			const { done, value } = await reader.read();
			if (done) break;
			if (!value?.byteLength) continue;
			total += value.byteLength;
			if (total > limit) {
				await reader.cancel().catch(() => undefined);
				throw new ResponseSizeLimitError(label, limit, total);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export async function readResponseText(
	response: Response,
	maxBytes: number,
	label = "Response body",
	signal?: AbortSignal,
): Promise<string> {
	return (await readResponseBuffer(response, maxBytes, label, signal)).toString("utf8");
}
