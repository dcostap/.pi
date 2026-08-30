const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/iu;
const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;

const UNITS: Record<string, number> = {
	s: 1000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

export function parseDuration(input: string): { text: string; milliseconds: number } {
	const match = input.trim().match(DURATION_PATTERN);
	if (!match) throw new Error('Interval must use a value such as "30s", "10m", "2h", or "1d"');
	const value = Number(match[1]);
	const unit = match[2]!.toLowerCase();
	const milliseconds = Math.round(value * UNITS[unit]!);
	if (!Number.isFinite(milliseconds) || milliseconds < MIN_INTERVAL_MS) {
		throw new Error("Interval must be at least 10 seconds");
	}
	if (milliseconds > MAX_INTERVAL_MS) throw new Error("Interval must not exceed 365 days");
	return { text: `${value}${unit}`, milliseconds };
}

export function formatRemaining(milliseconds: number): string {
	if (milliseconds <= 0) return "due";
	const seconds = Math.ceil(milliseconds / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.ceil(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.ceil(hours / 24)}d`;
}

export function formatElapsed(milliseconds: number): string {
	if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
	if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
	if (milliseconds < 3_600_000) return `${Math.round(milliseconds / 60_000)}m`;
	return `${Math.round(milliseconds / 3_600_000)}h`;
}
