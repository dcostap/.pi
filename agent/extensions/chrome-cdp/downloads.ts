import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export type Download = {
  id: string; browserId: string; outputPath: string; state: "running" | "complete" | "failed" | "cancelled";
  bytes: number; total?: number; started: number; ended?: number; error?: string;
};
type Job = { view: Download; controller: AbortController; done: Promise<void>; background: boolean };

export function formatDownload(d: Download): string {
  const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  const speed = d.bytes / Math.max(0.001, ((d.ended ?? Date.now()) - d.started) / 1000);
  const progress = `${bytes(d.bytes)}${d.total == null ? "" : ` / ${bytes(d.total)}`}`;
  const eta = d.total != null && speed > 0 ? ` · about ${Math.ceil(Math.max(0, d.total - d.bytes) / speed)}s left` : "";
  return `${d.id} · ${d.state} · ${basename(d.outputPath)} · ${progress}${d.state === "running" ? ` · ${bytes(speed)}/s${eta}` : ""}${d.error ? ` · ${d.error}` : ""}`;
}

export class DownloadManager {
  private jobs = new Map<string, Job>();
  private closed = false;
  constructor(private changed: () => void = () => {}, private completed: (view: Download) => void = () => {}) {}

  list(browserId?: string): Download[] {
    return [...this.jobs.values()].map(j => ({ ...j.view })).filter(d => !browserId || d.browserId === browserId);
  }
  private job(id: string, browserId: string): Job {
    const job = this.jobs.get(id);
    if (!job || job.view.browserId !== browserId) throw new Error(`No download ${id} for browser ${browserId}`);
    return job;
  }
  get(id: string, browserId: string): Download { return { ...this.job(id, browserId).view }; }

  start(options: { browserId: string; url: string; outputPath: string; headers?: Record<string, string>; timeoutMs?: number }): Download {
    if (this.closed) throw new Error("Download manager is closed");
    if (options.timeoutMs != null && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2147483647)) throw new Error("Invalid download timeoutMs");
    const out = resolve(options.outputPath);
    const key = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
    if (this.list().some(d => d.state === "running" && key(d.outputPath) === key(out))) throw new Error(`Download already writes to ${out}`);
    const view: Download = { id: `dl-${randomUUID().slice(0, 8)}`, browserId: options.browserId, outputPath: out, state: "running", bytes: 0, started: Date.now() };
    const job: Job = { view, controller: new AbortController(), done: Promise.resolve(), background: false };
    this.jobs.set(view.id, job);
    job.done = this.transfer(job, options);
    // Keep all active jobs and only the 30 most recent finished jobs.
    const finished = [...this.jobs.values()].filter(j => j.view.state !== "running");
    for (const old of finished.slice(0, Math.max(0, finished.length - 30))) this.jobs.delete(old.view.id);
    this.changed();
    return { ...view };
  }

  background(id: string, browserId: string): void {
    const job = this.job(id, browserId);
    job.background = true;
    if (job.view.state !== "running") this.completed({ ...job.view });
  }

  async wait(id: string, browserId: string, ms: number, signal?: AbortSignal): Promise<Download> {
    const job = this.job(id, browserId);
    // Aborting a wait does not abort the transfer.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interrupt: () => void = () => {};
    const stopped = new Promise<void>(resolve => {
      interrupt = resolve;
      timer = setTimeout(resolve, ms);
      if (signal?.aborted) resolve();
      else signal?.addEventListener("abort", interrupt, { once: true });
    });
    try { await Promise.race([job.done, stopped]); }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", interrupt); }
    return { ...job.view };
  }

  async cancel(id: string, browserId: string): Promise<Download> {
    const job = this.job(id, browserId);
    if (job.view.state === "running") job.controller.abort(new Error("Download cancelled"));
    await job.done;
    return { ...job.view };
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort(new Error("Session closed"));
    await Promise.all([...this.jobs.values()].map(j => j.done));
  }

  private async transfer(job: Job, options: { url: string; headers?: Record<string, string>; timeoutMs?: number }): Promise<void> {
    const { view, controller } = job;
    const part = `${view.outputPath}.${view.id}.part`;
    let timedOut = false;
    const timer = options.timeoutMs == null ? undefined : setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Download timed out"));
    }, options.timeoutMs);
    try {
      const response = await fetch(options.url, { headers: options.headers, signal: controller.signal });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status} ${response.statusText}`); }
      if (!response.body) throw new Error("Download response has no body");
      const length = response.headers.get("content-length");
      if (!response.headers.get("content-encoding") && length != null && /^\d+$/.test(length)) view.total = Number(length);
      await mkdir(dirname(view.outputPath), { recursive: true });
      await pipeline(Readable.fromWeb(response.body as any), new Transform({
        transform(chunk, _encoding, callback) { view.bytes += chunk.length; callback(null, chunk); },
      }), createWriteStream(part, { flags: "wx", mode: 0o600 }), { signal: controller.signal });
      controller.signal.throwIfAborted();
      if (view.total != null && view.bytes !== view.total) throw new Error("Download size does not match Content-Length");
      await rename(part, view.outputPath);
      view.state = "complete";
    } catch (error: any) {
      view.state = controller.signal.aborted && !timedOut ? "cancelled" : "failed";
      view.error = timedOut ? `Download timed out after ${options.timeoutMs}ms` : String(error?.message ?? error);
      await rm(part, { force: true }).catch(() => {});
    } finally {
      clearTimeout(timer);
      view.ended = Date.now();
      this.changed();
      if (job.background && !this.closed) this.completed({ ...view });
    }
  }
}
