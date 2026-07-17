import { isAbsolute, resolve } from "node:path";
import type { ExecutePatchResult, ParsedPatchAction } from "../patch/types.ts";
import { formatPatchTarget } from "./rendering.ts";

export interface AppliedPatchChange {
	path: string;
	kind: "add" | "delete" | "update";
	movePath?: string | null;
}

export interface ActionClassification {
	attemptedFiles: string[];
	appliedFiles: string[];
	failedFiles: string[];
	failedActionIndexes: number[];
}

export function formatPartialProgress(attemptedFiles: string[], applied: number): string {
	const attempted = attemptedFiles.length;
	if (new Set(attemptedFiles).size < attempted) {
		return `${applied} of ${attempted} changes applied`;
	}
	return `${applied} of ${attempted} ${attempted === 1 ? "file" : "files"} changed`;
}

function pathKey(cwd: string, path: string): string {
	const absolute = isAbsolute(path) ? path : resolve(cwd, path);
	const normalized = absolute.replace(/\\/g, "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function changeMatchesAction(change: AppliedPatchChange, action: ParsedPatchAction, cwd: string): boolean {
	return change.kind === action.type &&
		pathKey(cwd, change.path) === pathKey(cwd, action.path) &&
		(!action.movePath || (
			change.movePath !== undefined &&
			change.movePath !== null &&
			pathKey(cwd, change.movePath) === pathKey(cwd, action.movePath)
		));
}

export function classifyActions(
	actions: ParsedPatchAction[],
	result: ExecutePatchResult,
	cwd: string,
	changes?: AppliedPatchChange[],
): ActionClassification {
	const changedPaths = new Set(result.changedFiles.map((path) => pathKey(cwd, path)));
	const attemptedFiles: string[] = [];
	const appliedFiles: string[] = [];
	const failedFiles: string[] = [];
	const failedActionIndexes: number[] = [];
	let changeIndex = 0;

	for (const [actionIndex, action] of actions.entries()) {
		const target = formatPatchTarget(action.path, action.movePath, cwd);
		const mutationPaths = action.movePath ? [action.path, action.movePath] : [action.path];
		const appliedFromDelta = changes !== undefined &&
			changes[changeIndex] !== undefined &&
			changeMatchesAction(changes[changeIndex]!, action, cwd);
		const applied = changes === undefined
			? mutationPaths.every((path) => changedPaths.has(pathKey(cwd, path)))
			: appliedFromDelta;

		if (appliedFromDelta) changeIndex += 1;
		attemptedFiles.push(target);
		if (applied) {
			appliedFiles.push(target);
		} else {
			failedFiles.push(target);
			failedActionIndexes.push(actionIndex);
		}
	}

	return { attemptedFiles, appliedFiles, failedFiles, failedActionIndexes };
}
