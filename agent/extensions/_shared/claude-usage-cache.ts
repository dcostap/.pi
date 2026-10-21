import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export const CLAUDE_USAGE_INTERVAL_MS = 60 * 60 * 1000;

interface Snapshot<T> {
  attemptedAt: number;
  data?: T;
}

export function readUsageSnapshot<T>(file: string): Snapshot<T> | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return Number.isFinite(value?.attemptedAt) ? value : undefined;
  } catch {
    return undefined;
  }
}

function save<T>(file: string, snapshot: Snapshot<T>): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Share results and a rolling cooldown across local Pi processes. No credentials are stored. */
export async function sharedClaudeUsage<T>(
  file: string,
  fetchUsage: () => Promise<T>,
  manual = false,
  now = Date.now,
): Promise<T | undefined> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const started = Date.now();
  // Manual refreshes wait for the current request, which has a 12-second timeout.
  while (true) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Do not steal a lock: a paused process may still own it.
      if (!manual) return readUsageSnapshot<T>(file)?.data;
      if (Date.now() - started >= 15_000) {
        throw new Error(`Claude usage refresh is busy. If no Pi refresh is running, remove ${lock}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  try {
    const previous = readUsageSnapshot<T>(file);
    const attemptedAt = now();
    if (!manual && previous && attemptedAt - previous.attemptedAt < CLAUDE_USAGE_INTERVAL_MS) {
      return previous.data;
    }
    // Reserve before the request. Errors and process exits also start the cooldown.
    save(file, { attemptedAt, data: previous?.data });
    const data = await fetchUsage();
    save(file, { attemptedAt, data });
    return data;
  } finally {
    fs.rmdirSync(lock);
  }
}
