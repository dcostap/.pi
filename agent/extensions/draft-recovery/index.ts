import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
	archiveDraft,
	deleteDraft,
	DraftWritePump,
	listDrafts,
	pruneDrafts,
	readDraft,
	type DraftRecord,
	writeDraft,
} from "./storage";

const DRAFT_DIR = join(getAgentDir(), "drafts");
const POLL_INTERVAL_MS = 250;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const RECENT_OTHER_DRAFT_MS = 7 * 24 * 60 * 60 * 1000;

interface Runtime {
	sessionId: string;
	sessionFile: string;
	cwd: string;
	ctx: ExtensionContext;
	timer: ReturnType<typeof setInterval>;
	pump: DraftWritePump;
	generation: number;
	lastQueuedText: string;
	paused: boolean;
	active: boolean;
	lastErrorNotificationAt: number;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function preview(text: string, maxLength = 64): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= maxLength) return oneLine || "(empty)";
	return `${oneLine.slice(0, maxLength - 3)}...`;
}

function ageLabel(updatedAt: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function makeRecord(runtime: Runtime, text: string): DraftRecord {
	return {
		version: 1,
		sessionId: runtime.sessionId,
		sessionFile: runtime.sessionFile,
		cwd: runtime.cwd,
		updatedAt: Date.now(),
		text,
	};
}

function queueText(runtime: Runtime, text: string): void {
	if (!runtime.active || text === runtime.lastQueuedText) return;
	runtime.lastQueuedText = text;
	const generation = ++runtime.generation;
	runtime.pump.request({ generation, record: text.length > 0 ? makeRecord(runtime, text) : null });
}

function observeEditor(runtime: Runtime): void {
	if (!runtime.active || runtime.paused) return;
	try {
		queueText(runtime, runtime.ctx.ui.getEditorText());
	} catch {
		// The old context can become stale during session replacement. Shutdown
		// performs a final observation before the runtime is invalidated.
	}
}

export default function (pi: ExtensionAPI) {
	let runtime: Runtime | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return; // --no-session cannot be reopened, so avoid orphan drafts.

		const sessionId = ctx.sessionManager.getSessionId();
		let persisted: DraftRecord | undefined;
		try {
			await pruneDrafts(DRAFT_DIR, Date.now() - RETENTION_MS);
			persisted = await readDraft(DRAFT_DIR, sessionId);
		} catch (error) {
			ctx.ui.notify(`Draft recovery could not read its storage: ${describeError(error)}`, "error");
		}

		let initialText = ctx.ui.getEditorText();
		if (persisted?.text && initialText.length === 0) {
			ctx.ui.setEditorText(persisted.text);
			initialText = persisted.text;
			ctx.ui.notify(`Recovered unsent draft from ${ageLabel(persisted.updatedAt)}.`, "info");
		} else if (persisted?.text && persisted.text !== initialText) {
			// Preserve both texts rather than silently overwriting either one.
			try {
				await archiveDraft(DRAFT_DIR, persisted);
				ctx.ui.notify("An older conflicting draft was archived; use /drafts to recover it.", "warning");
			} catch (error) {
				ctx.ui.notify(`Could not archive a conflicting draft: ${describeError(error)}`, "error");
			}
		}

		const newRuntime = {} as Runtime;
		Object.assign(newRuntime, {
			sessionId,
			sessionFile,
			cwd: ctx.cwd,
			ctx,
			generation: 0,
			lastQueuedText: persisted?.text ?? "",
			paused: false,
			active: true,
			lastErrorNotificationAt: 0,
		});

		newRuntime.pump = new DraftWritePump(
			async (write) => {
				if (write.record) await writeDraft(DRAFT_DIR, write.record);
				else await deleteDraft(DRAFT_DIR, sessionId);
			},
			() => undefined,
			(write, error) => {
				if (write.generation === newRuntime.generation) newRuntime.lastQueuedText = "\u0000retry";
				const now = Date.now();
				if (newRuntime.active && now - newRuntime.lastErrorNotificationAt > 30_000) {
					newRuntime.lastErrorNotificationAt = now;
					ctx.ui.notify(`Could not save draft: ${describeError(error)}`, "error");
				}
			},
		);
		newRuntime.timer = setInterval(() => observeEditor(newRuntime), POLL_INTERVAL_MS);
		newRuntime.timer.unref?.();
		runtime = newRuntime;

		// Save initial text supplied by Pi or another extension, unless it exactly
		// matches the draft we just restored.
		queueText(newRuntime, initialText);

		if (!persisted && initialText.length === 0) {
			try {
				const other = (await listDrafts(DRAFT_DIR)).find(
					(record) =>
						record.sessionId !== sessionId &&
						record.cwd === ctx.cwd &&
						Date.now() - record.updatedAt <= RECENT_OTHER_DRAFT_MS,
				);
				if (other) ctx.ui.notify("An unsent draft exists in another session; use /drafts to recover it.", "warning");
			} catch {
				// The primary read already reports storage errors; this hint is best effort.
			}
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const current = runtime;
		if (!current) return;
		clearInterval(current.timer);
		observeEditor(current);
		current.active = false;
		await current.pump.flush();
		if (runtime === current) runtime = undefined;
	});

	pi.registerCommand("draft-recover", {
		description: "Restore the current session's saved unsent draft into the editor",
		handler: async (_args, ctx) => {
			const current = runtime;
			if (current) current.paused = true;
			try {
				const draft = await readDraft(DRAFT_DIR, ctx.sessionManager.getSessionId());
				if (!draft?.text) {
					ctx.ui.notify("No saved draft for this session.", "info");
					return;
				}
				ctx.ui.setEditorText(draft.text);
				ctx.ui.notify(`Recovered draft from ${ageLabel(draft.updatedAt)}.`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not recover draft: ${describeError(error)}`, "error");
			} finally {
				if (current) {
					current.paused = false;
					observeEditor(current);
				}
			}
		},
	});

	pi.registerCommand("draft-clear", {
		description: "Delete the current session's saved unsent draft",
		handler: async (_args, ctx) => {
			const current = runtime;
			try {
				if (current && current.sessionId === ctx.sessionManager.getSessionId()) {
					current.lastQueuedText = "";
					const generation = ++current.generation;
					current.pump.request({ generation, record: null });
					await current.pump.flush();
				} else {
					await deleteDraft(DRAFT_DIR, ctx.sessionManager.getSessionId());
				}
				ctx.ui.notify("Saved draft cleared.", "info");
			} catch (error) {
				ctx.ui.notify(`Could not clear draft: ${describeError(error)}`, "error");
			}
		},
	});

	pi.registerCommand("drafts", {
		description: "Browse and restore saved drafts from any session",
		handler: async (_args, ctx) => {
			const current = runtime;
			if (current) current.paused = true;
			try {
				const drafts = await listDrafts(DRAFT_DIR);
				if (drafts.length === 0) {
					ctx.ui.notify("No saved drafts.", "info");
					return;
				}

				const labels = drafts.map((draft, index) => {
					const project = draft.cwd === ctx.cwd ? "this project" : draft.cwd;
					return `${index + 1}. ${ageLabel(draft.updatedAt)} · ${project} · ${preview(draft.text)}`;
				});
				const selected = await ctx.ui.select("Recover which draft?", labels);
				if (!selected) return;
				const index = labels.indexOf(selected);
				const draft = drafts[index];
				if (!draft) return;

				// Browsing is a copy operation. Preserve a different current-session
				// draft before the selected text takes over its autosave slot.
				const existing = await readDraft(DRAFT_DIR, ctx.sessionManager.getSessionId());
				if (existing?.text && existing.text !== draft.text) await archiveDraft(DRAFT_DIR, existing);
				ctx.ui.setEditorText(draft.text);
				ctx.ui.notify("Draft copied into the current editor.", "info");
			} catch (error) {
				ctx.ui.notify(`Could not list drafts: ${describeError(error)}`, "error");
			} finally {
				if (current) {
					current.paused = false;
					observeEditor(current);
				}
			}
		},
	});
}
