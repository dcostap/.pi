/** Read file paths from output markers emitted by this extension. */
export function savedOutputPaths(text: string, action: string, outputPath?: string): string[] {
	const savesOutput = ["snap", "html", "inspect", "diagnostics", "eval", "script", "net", "raw", "download", "shot"].includes(action);
	const paths = outputPath && savesOutput ? [outputPath] : [];
	for (const match of text.matchAll(/^\[(?:Saved|Dumped) [\d.]+KB \/ \d+ lines to (.+?)(?: \| .*?)?\]$/gm)) {
		paths.push(match[1]!);
	}
	for (const match of text.matchAll(/^\[Full accessibility tree saved to (.+)\]$/gm)) paths.push(match[1]!);
	if (action === "shot" || action === "download") {
		const firstLine = text.split("\n", 1)[0];
		if (firstLine && /\n(?:Screenshot saved|Downloaded) /.test(text)) paths.push(firstLine);
	}
	return [...new Set(paths)];
}
