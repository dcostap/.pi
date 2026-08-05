export const SPINNER_INTERVAL_MS = 120;

const DEFAULT_SPINNER_FRAMES = ["·", "✢", "*", "✶", "✻", "✽"] as const;
const MACOS_SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"] as const;

export const SPINNER_FRAMES: readonly string[] = process.platform === "darwin"
	? MACOS_SPINNER_FRAMES
	: DEFAULT_SPINNER_FRAMES;

const REDUCED_MOTION_VALUES = new Set(["1", "true", "yes", "on"]);

/** Honor an explicit terminal-extension preference without animating by default. */
export function isReducedMotion(): boolean {
	return REDUCED_MOTION_VALUES.has((process.env.PI_REDUCED_MOTION ?? "").trim().toLowerCase());
}

/** Return the frame for a millisecond clock value. */
export function spinnerFrame(time: number, reducedMotion = isReducedMotion()): string {
	if (reducedMotion) return SPINNER_FRAMES[0]!;
	const elapsed = Number.isFinite(time) ? Math.max(0, time) : 0;
	const frame = Math.floor(elapsed / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
	return SPINNER_FRAMES[frame]!;
}

/** Request TUI renders at the spinner cadence, and cleanly stop when unmounted. */
export function createSpinnerTicker(
	requestRender: () => void,
	reducedMotion = isReducedMotion(),
): { dispose(): void } {
	if (reducedMotion) return { dispose() {} };
	const timer = setInterval(requestRender, SPINNER_INTERVAL_MS);
	return {
		dispose() {
			clearInterval(timer);
		},
	};
}
