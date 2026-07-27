const MAX_VISIBLE_REASON_CHARS = 180;

function firstDiagnosticLine(rawText: string): string {
	return rawText
		.trim()
		.split(/\r?\n/)
		.find((line) => line.trim().length > 0)
		?.trim() ?? "The patch could not be applied.";
}

function truncateReason(reason: string): string {
	if (reason.length <= MAX_VISIBLE_REASON_CHARS) return reason;
	return `${reason.slice(0, MAX_VISIBLE_REASON_CHARS - 1).trimEnd()}…`;
}

/**
 * Turn a potentially multi-line apply_patch diagnostic into a short TUI-only
 * explanation. The complete diagnostic remains in the tool result for the
 * model; it should not be dumped into the user's chat transcript.
 */
export function conciseApplyPatchFailureReason(rawText: string, failedTarget?: string): string {
	if (/Failed to find (?:expected lines|context)\b/i.test(rawText)) {
		return `Expected lines no longer matched${failedTarget ? ` in ${failedTarget}` : " the target file"}.`;
	}
	if (/apply_patch aborted|\b(?:aborted|cancelled)\b/i.test(rawText)) {
		return "The patch was cancelled.";
	}

	const reason = firstDiagnosticLine(rawText)
		.replace(/^Patch partially applied:\s*/i, "")
		.replace(/^Error:\s*/i, "")
		.replace(/^apply_patch failed:\s*/i, "")
		.trim();
	return truncateReason(reason || "The patch could not be applied.");
}
