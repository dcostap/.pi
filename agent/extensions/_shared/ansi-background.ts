const ANSI_BACKGROUND_RESET = /\u001b\[(?:0|49)m/g;

/** Keep an enclosing background active after nested ANSI styles reset it. */
export function withPreservedAnsiBackground(text: string, applyBackground: (value: string) => string): string {
	const marker = "__PI_BACKGROUND_MARKER__";
	const wrappedMarker = applyBackground(marker);
	const markerIndex = wrappedMarker.indexOf(marker);
	if (markerIndex < 0) return applyBackground(text);
	const opening = wrappedMarker.slice(0, markerIndex);
	const closing = wrappedMarker.slice(markerIndex + marker.length);
	const repaired = text.replace(ANSI_BACKGROUND_RESET, (reset) => `${reset}${opening}`);
	return `${opening}${repaired}${closing}`;
}
