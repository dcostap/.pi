import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { posix } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { Client, SFTPWrapper, Stats } from "ssh2";

export interface TransferRequest {
	readonly client: Client;
	readonly localPath: string;
	readonly remotePath: string;
	readonly overwrite: boolean;
	readonly mode?: number;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly onProgress?: (message: string, transferredBytes: number, totalBytes: number) => void;
}

export interface TransferResult {
	readonly localPath: string;
	readonly remotePath: string;
	readonly bytes: number;
	readonly sha256: string;
	readonly elapsedMs: number;
	readonly remoteMode: number;
}

export function resolveLocalTransferPath(value: string, cwd: string): string {
	const path = normalizePathArgument(value, "local_path");
	return resolve(cwd, path);
}

export function resolveRemoteTransferPath(value: string, cwd: string): string {
	const path = normalizePathArgument(value, "remote_path");
	if (!cwd.startsWith("/")) throw new Error("Remote transfer cwd must be an absolute POSIX path");
	return posix.resolve(cwd, path);
}

export async function uploadFile(request: TransferRequest): Promise<TransferResult> {
	const source = await stat(request.localPath);
	if (!source.isFile()) throw new Error(`Upload source is not a regular file: ${request.localPath}`);

	const startedAt = Date.now();
	const transfer = createTransferAbort(request.signal, request.timeoutMs);
	const temporaryPath = remoteTemporaryPath(request.remotePath, "upload");
	let sftp: SFTPWrapper | undefined;
	let temporaryExists = false;

	try {
		transfer.throwIfAborted();
		sftp = await openSftp(request.client, transfer.signal);
		const destination = await remoteLstatIfExists(sftp, request.remotePath, transfer.signal);
		if (destination?.isDirectory()) throw new Error(`Upload destination is a directory: ${request.remotePath}`);
		if (destination && !request.overwrite) throw new Error(`Remote destination already exists: ${request.remotePath}`);

		const meter = new TransferMeter("Uploading", request.localPath, request.remotePath, source.size, request.onProgress);
		const createMode = request.mode ?? (source.mode & 0o777);
		temporaryExists = true;
		await pipeline(
			createReadStream(request.localPath),
			meter,
			sftp.createWriteStream(temporaryPath, { flags: "wx", mode: createMode }),
			{ signal: transfer.signal },
		);
		if (meter.bytes !== source.size) {
			throw new Error(`Upload source changed during transfer (expected ${source.size} bytes, read ${meter.bytes})`);
		}
		if (request.mode !== undefined) {
			await sftpCall<void>((callback) => sftp!.chmod(temporaryPath, request.mode!, callback), transfer.signal);
		}
		const uploaded = await sftpCall<Stats>((callback) => sftp!.stat(temporaryPath, callback), transfer.signal);
		if (uploaded.size !== meter.bytes) {
			throw new Error(`Remote upload size mismatch (sent ${meter.bytes} bytes, remote file has ${uploaded.size})`);
		}

		await commitRemoteFile(sftp, temporaryPath, request.remotePath, Boolean(destination), request.overwrite, transfer.signal);
		temporaryExists = false;
		const committed = await sftpCall<Stats>((callback) => sftp!.stat(request.remotePath, callback), transfer.signal);
		return {
			localPath: request.localPath,
			remotePath: request.remotePath,
			bytes: meter.bytes,
			sha256: meter.digest(),
			elapsedMs: Date.now() - startedAt,
			remoteMode: committed.mode & 0o777,
		};
	} catch (error) {
		throw transfer.normalizeError(error, "Upload");
	} finally {
		if (temporaryExists && sftp) await bestEffortRemoteUnlink(sftp, temporaryPath);
		closeSftp(sftp);
		transfer.dispose();
	}
}

export async function downloadFile(request: TransferRequest): Promise<TransferResult> {
	return withFileMutationQueue(request.localPath, async () => {
		const startedAt = Date.now();
		const transfer = createTransferAbort(request.signal, request.timeoutMs);
		const temporaryPath = localTemporaryPath(request.localPath, "download");
		let sftp: SFTPWrapper | undefined;
		let temporaryExists = false;

		try {
			transfer.throwIfAborted();
			sftp = await openSftp(request.client, transfer.signal);
			const source = await sftpCall<Stats>((callback) => sftp!.stat(request.remotePath, callback), transfer.signal);
			if (!source.isFile()) throw new Error(`Download source is not a regular file: ${request.remotePath}`);

			await mkdir(dirname(request.localPath), { recursive: true });
			const destination = await localLstatIfExists(request.localPath);
			if (destination?.isDirectory()) throw new Error(`Download destination is a directory: ${request.localPath}`);
			if (destination && !request.overwrite) throw new Error(`Local destination already exists: ${request.localPath}`);

			const meter = new TransferMeter("Downloading", request.remotePath, request.localPath, source.size, request.onProgress);
			temporaryExists = true;
			await pipeline(
				sftp.createReadStream(request.remotePath),
				meter,
				createWriteStream(temporaryPath, { flags: "wx", mode: source.mode & 0o777 }),
				{ signal: transfer.signal },
			);
			if (meter.bytes !== source.size) {
				throw new Error(`Remote source changed during transfer (expected ${source.size} bytes, received ${meter.bytes})`);
			}

			transfer.throwIfAborted();
			await commitLocalFile(temporaryPath, request.localPath, Boolean(destination), request.overwrite);
			temporaryExists = false;
			return {
				localPath: request.localPath,
				remotePath: request.remotePath,
				bytes: meter.bytes,
				sha256: meter.digest(),
				elapsedMs: Date.now() - startedAt,
				remoteMode: source.mode & 0o777,
			};
		} catch (error) {
			throw transfer.normalizeError(error, "Download");
		} finally {
			if (temporaryExists) await rm(temporaryPath, { force: true }).catch(() => undefined);
			closeSftp(sftp);
			transfer.dispose();
		}
	});
}

class TransferMeter extends Transform {
	readonly hash = createHash("sha256");
	bytes = 0;
	private lastUpdate = 0;
	private finalizedDigest?: string;

	constructor(
		private readonly verb: string,
		private readonly source: string,
		private readonly destination: string,
		private readonly totalBytes: number,
		private readonly onProgress?: TransferRequest["onProgress"],
	) {
		super();
		this.report(true);
	}

	_transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
		const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
		this.hash.update(data);
		this.bytes += data.length;
		this.report(false);
		callback(null, data);
	}

	_flush(callback: TransformCallback): void {
		this.report(true);
		callback();
	}

	digest(): string {
		this.finalizedDigest ??= this.hash.digest("hex");
		return this.finalizedDigest;
	}

	private report(force: boolean): void {
		const now = Date.now();
		if (!force && now - this.lastUpdate < 250) return;
		this.lastUpdate = now;
		const percent = this.totalBytes === 0 ? 100 : Math.min(100, Math.floor((this.bytes / this.totalBytes) * 100));
		try {
			this.onProgress?.(
				`${this.verb} ${basename(this.source)}: ${formatBytes(this.bytes)} / ${formatBytes(this.totalBytes)} (${percent}%)\n${this.source} → ${this.destination}`,
				this.bytes,
				this.totalBytes,
			);
		} catch {
			// Rendering progress must not interrupt the transfer.
		}
	}
}

async function commitRemoteFile(
	sftp: SFTPWrapper,
	temporaryPath: string,
	destinationPath: string,
	destinationExists: boolean,
	overwrite: boolean,
	signal: AbortSignal,
): Promise<void> {
	if (destinationExists && overwrite) {
		await sftpCall<void>((callback) => sftp.ext_openssh_rename(temporaryPath, destinationPath, callback), signal).catch((error) => {
			throw new Error(`Server could not atomically replace ${destinationPath}: ${errorMessage(error)}`);
		});
		return;
	}
	await sftpCall<void>((callback) => sftp.rename(temporaryPath, destinationPath, callback), signal);
}

async function commitLocalFile(
	temporaryPath: string,
	destinationPath: string,
	destinationExists: boolean,
	overwrite: boolean,
): Promise<void> {
	if (!overwrite) {
		// A same-directory hard link provides portable, atomic no-clobber semantics.
		// A plain rename would silently replace a file created after our existence check.
		await link(temporaryPath, destinationPath);
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		return;
	}
	if (!destinationExists || process.platform !== "win32") {
		await rename(temporaryPath, destinationPath);
		return;
	}

	// Node's Windows rename does not replace an existing file. Keep a rollback copy
	// so a failed replacement does not destroy the previous destination.
	const backupPath = localTemporaryPath(destinationPath, "backup");
	await rename(destinationPath, backupPath);
	try {
		await rename(temporaryPath, destinationPath);
	} catch (error) {
		await rename(backupPath, destinationPath).catch(() => undefined);
		throw error;
	}
	await rm(backupPath, { force: true });
}

async function openSftp(client: Client, signal: AbortSignal): Promise<SFTPWrapper> {
	return new Promise((resolvePromise, reject) => {
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			reject(new Error("Transfer aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		client.sftp((error, sftp) => {
			signal.removeEventListener("abort", onAbort);
			if (settled) {
				closeSftp(sftp);
				return;
			}
			settled = true;
			if (error) reject(error);
			else resolvePromise(sftp);
		});
		if (signal.aborted) onAbort();
	});
}

function sftpCall<T>(
	invoke: (callback: (error?: Error, value?: T) => void) => void,
	signal: AbortSignal,
): Promise<T> {
	return new Promise<T>((resolvePromise, reject) => {
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			reject(new Error("Transfer aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		invoke((error, value) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolvePromise(value as T);
		});
		if (signal.aborted) onAbort();
	});
}

async function remoteLstatIfExists(sftp: SFTPWrapper, path: string, signal: AbortSignal): Promise<Stats | undefined> {
	try {
		return await sftpCall<Stats>((callback) => sftp.lstat(path, callback), signal);
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw error;
	}
}

async function localLstatIfExists(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw error;
	}
}

async function bestEffortRemoteUnlink(sftp: SFTPWrapper, path: string): Promise<void> {
	const timeout = AbortSignal.timeout(3000);
	await sftpCall<void>((callback) => sftp.unlink(path, callback), timeout).catch(() => undefined);
}

function closeSftp(sftp: SFTPWrapper | undefined): void {
	if (!sftp) return;
	try {
		sftp.end();
	} catch {
		try {
			sftp.destroy();
		} catch {}
	}
}

function createTransferAbort(parent: AbortSignal | undefined, timeoutMs: number | undefined) {
	const controller = new AbortController();
	let timedOut = false;
	const onParentAbort = () => controller.abort();
	parent?.addEventListener("abort", onParentAbort, { once: true });
	if (parent?.aborted) controller.abort();
	const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	return {
		signal: controller.signal,
		throwIfAborted() {
			if (controller.signal.aborted) throw new Error("Transfer aborted");
		},
		normalizeError(error: unknown, label: string): Error {
			if (timedOut) return new Error(`${label} timed out after ${timeoutMs}ms`);
			if (parent?.aborted) return new Error(`${label} aborted`);
			return error instanceof Error ? error : new Error(String(error));
		},
		dispose() {
			if (timer) clearTimeout(timer);
			parent?.removeEventListener("abort", onParentAbort);
		},
	};
}

function normalizePathArgument(value: string, name: string): string {
	const path = value.startsWith("@") ? value.slice(1) : value;
	if (!path || /^\s+$/u.test(path) || path.includes("\0")) throw new Error(`${name} must be a non-empty file path`);
	return path;
}

function remoteTemporaryPath(destination: string, label: string): string {
	return posix.join(posix.dirname(destination), `.pi-${label}-${randomBytes(12).toString("hex")}`);
}

function localTemporaryPath(destination: string, label: string): string {
	return resolve(dirname(destination), `.pi-${label}-${randomBytes(12).toString("hex")}`);
}

function isNotFoundError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const code = (error as { code?: unknown }).code;
	return code === "ENOENT" || code === 2 || /no such file|not found/iu.test(errorMessage(error));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}
