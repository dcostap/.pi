import { parseDuration } from "./duration.ts";
import type { TodoChange, TodoItem, TodoSchedule, TodoState } from "./types.ts";

export const TODO_STATE_ENTRY = "todo-state-v1";

export function createTodoState(): TodoState {
	return {
		version: 1,
		enabled: false,
		scriptsEnabled: true,
		nextSequence: 1,
		items: [],
	};
}

export function cloneTodoState(state: TodoState): TodoState {
	return structuredClone(state);
}

export function restoreTodoState(entries: readonly unknown[]): TodoState {
	let restored: TodoState | undefined;
	for (const value of entries) {
		if (!value || typeof value !== "object") continue;
		const entry = value as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== TODO_STATE_ENTRY) continue;
		const candidate = normalizeStoredState(entry.data);
		if (candidate) restored = candidate;
	}
	return restored ?? createTodoState();
}

export function applyTodoChanges(state: TodoState, changes: readonly TodoChange[], now = Date.now()): TodoState {
	if (changes.length === 0) throw new Error("At least one todo change is required");
	if (changes.length > 100) throw new Error("At most 100 todo changes are allowed in one call");

	const next = cloneTodoState(state);
	for (const change of changes) applyChange(next, change, now);
	return next;
}

export function setFeatureEnabled(state: TodoState, enabled: boolean): TodoState {
	if (state.enabled === enabled) return state;
	return { ...cloneTodoState(state), enabled };
}

export function setScriptsEnabled(state: TodoState, enabled: boolean): TodoState {
	if (state.scriptsEnabled === enabled) return state;
	return { ...cloneTodoState(state), scriptsEnabled: enabled };
}

export function replaceItem(state: TodoState, item: TodoItem): TodoState {
	const index = state.items.findIndex((candidate) => candidate.id === item.id);
	if (index < 0) return state;
	const next = cloneTodoState(state);
	next.items[index] = structuredClone(item);
	return next;
}

export function findItem(state: TodoState, id: string): TodoItem {
	const item = state.items.find((candidate) => candidate.id === id);
	if (!item) throw new Error(`Unknown todo item: ${id}`);
	return item;
}

export function getCurrentTaskId(state: TodoState): string | undefined {
	const item = state.items.find((candidate) => candidate.id === state.currentTaskId);
	return item?.kind === "task" && !item.done ? item.id : undefined;
}

export function getRecentCompletedTasks(state: TodoState, limit = 4): TodoItem[] {
	if (limit <= 0) return [];
	return state.items
		.filter((item) => item.kind === "task" && item.done)
		.sort((left, right) => (left.completedAt ?? left.updatedAt) - (right.completedAt ?? right.updatedAt))
		.slice(-limit);
}

function applyChange(state: TodoState, change: TodoChange, now: number): void {
	switch (change.action) {
		case "add":
			addItem(state, change, now);
			return;
		case "edit": {
			const item = findItem(state, required(change.id, "id"));
			if (change.text !== undefined) item.text = cleanText(change.text, "text", 500);
			applyGroup(item, change);
			item.updatedAt = now;
			return;
		}
		case "complete": {
			const item = requireTask(state, required(change.id, "id"));
			item.done = true;
			item.completedAt = now;
			item.updatedAt = now;
			if (state.currentTaskId === item.id) state.currentTaskId = undefined;
			return;
		}
		case "reopen": {
			const item = requireTask(state, required(change.id, "id"));
			item.done = false;
			item.completedAt = undefined;
			item.updatedAt = now;
			return;
		}
		case "remove": {
			const id = required(change.id, "id");
			const index = state.items.findIndex((item) => item.id === id);
			if (index < 0) throw new Error(`Unknown todo item: ${id}`);
			state.items.splice(index, 1);
			if (state.currentTaskId === id) state.currentTaskId = undefined;
			return;
		}
		case "move":
			moveItem(state, change);
			return;
		case "set_current": {
			const item = findItem(state, required(change.id, "id"));
			if (item.kind !== "task") throw new Error(`${item.id} is a watch and cannot be current`);
			if (item.done) throw new Error(`${item.id} is completed and cannot be current`);
			state.currentTaskId = item.id;
			return;
		}
		case "clear_current":
			state.currentTaskId = undefined;
			return;
		case "set_schedule": {
			const item = findItem(state, required(change.id, "id"));
			item.schedule = buildSchedule(item, change);
			item.updatedAt = now;
			return;
		}
		case "disable_schedule": {
			const item = findItem(state, required(change.id, "id"));
			if (!item.schedule) throw new Error(`${item.id} has no schedule`);
			item.schedule.enabled = false;
			item.updatedAt = now;
			return;
		}
		case "rename_group": {
			const oldGroup = cleanText(required(change.group, "group"), "group", 100);
			const newGroup = cleanText(required(change.new_group, "new_group"), "new_group", 100);
			let found = false;
			for (const item of state.items) {
				if (item.group !== oldGroup) continue;
				item.group = newGroup;
				item.updatedAt = now;
				found = true;
			}
			if (!found) throw new Error(`Unknown todo group: ${oldGroup}`);
			return;
		}
	}
}

function addItem(state: TodoState, change: TodoChange, now: number): void {
	const kind = change.kind;
	if (kind !== "task" && kind !== "watch") throw new Error('kind must be "task" or "watch"');
	const id = `${kind === "task" ? "t" : "w"}-${state.nextSequence++}`;
	const item: TodoItem = {
		id,
		kind,
		text: cleanText(required(change.text, "text"), "text", 500),
		createdAt: now,
		updatedAt: now,
	};
	if (kind === "task") item.done = false;
	applyGroup(item, change);
	if (change.every !== undefined || change.schedule_action !== undefined || change.command !== undefined) {
		item.schedule = buildSchedule(item, change);
	}
	state.items.push(item);
}

function moveItem(state: TodoState, change: TodoChange): void {
	const id = required(change.id, "id");
	const index = state.items.findIndex((item) => item.id === id);
	if (index < 0) throw new Error(`Unknown todo item: ${id}`);
	const [item] = state.items.splice(index, 1);
	applyGroup(item!, change);
	if (change.before_id === undefined) {
		state.items.push(item!);
		return;
	}
	if (change.before_id === id) throw new Error("An item cannot move before itself");
	const target = state.items.findIndex((candidate) => candidate.id === change.before_id);
	if (target < 0) throw new Error(`Unknown before_id: ${change.before_id}`);
	state.items.splice(target, 0, item!);
}

function buildSchedule(item: TodoItem, change: TodoChange): TodoSchedule {
	const action = change.schedule_action ?? (change.command ? "command" : "remind");
	if (action !== "remind" && action !== "command") throw new Error("Invalid schedule_action");
	if (item.kind === "task" && action === "command") throw new Error("Only watches can run scheduled commands");
	const parsed = parseDuration(required(change.every, "every"));
	const command = action === "command" ? cleanText(required(change.command, "command"), "command", 8000) : undefined;
	const cwd = change.cwd?.trim().replace(/^@(?=[A-Za-z]:[\\/]|[./\\])/u, "") || undefined;
	const timeoutSeconds = change.timeout_seconds ?? 300;
	if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) {
		throw new Error("timeout_seconds must be an integer from 1 through 86400");
	}
	return {
		enabled: true,
		every: parsed.text,
		intervalMs: parsed.milliseconds,
		action,
		command,
		cwd,
		timeoutSeconds: action === "command" ? timeoutSeconds : undefined,
	};
}

function requireTask(state: TodoState, id: string): TodoItem {
	const item = findItem(state, id);
	if (item.kind !== "task") throw new Error(`${id} is a watch and cannot be checked`);
	return item;
}

function applyGroup(item: TodoItem, change: Pick<TodoChange, "group" | "clear_group">): void {
	if (change.clear_group) item.group = undefined;
	else if (change.group !== undefined) item.group = cleanText(change.group, "group", 100);
}

function required(value: string | undefined, name: string): string {
	if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
	return value;
}

function cleanText(value: string, name: string, maxLength: number): string {
	const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").trim();
	if (!cleaned) throw new Error(`${name} must not be empty`);
	if (cleaned.length > maxLength) throw new Error(`${name} must not exceed ${maxLength} characters`);
	return cleaned;
}

function normalizeStoredState(value: unknown): TodoState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const state = value as Partial<TodoState>;
	if (state.version !== 1 || !Array.isArray(state.items)) return undefined;
	const items = structuredClone(state.items);
	const current = items.find((item) => item.id === state.currentTaskId);
	return {
		version: 1,
		enabled: state.enabled === true,
		scriptsEnabled: state.scriptsEnabled !== false,
		nextSequence: Number.isInteger(state.nextSequence) ? Math.max(1, state.nextSequence!) : state.items.length + 1,
		currentTaskId: current?.kind === "task" && !current.done ? current.id : undefined,
		items,
	};
}
