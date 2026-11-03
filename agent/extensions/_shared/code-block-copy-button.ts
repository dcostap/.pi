import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

// Pi keeps no public hook for code blocks. Wrap the private `renderToken` of Markdown to add a
// label to each fence line, and add `handleMouse` to copy the block's source on a click.
// Check the members before installing, so a Pi update turns the button off, not the transcript.
export const COPY_LABEL = "⧉ copy";
export const COPIED_LABEL = "✓ copied";
export const FAILED_LABEL = "✗ failed";
const RESULT_MS = 1500;

interface Token {
	type: string;
	text?: string;
}

interface MouseEvent {
	type: string;
	button: string;
	x: number;
	y: number;
}

interface MouseResult {
	handled: boolean;
	render?: boolean;
}

interface MarkdownLike {
	theme: { link: (text: string) => string };
	cachedLines?: string[];
	renderToken(token: Token, width: number, nextTokenType?: string, styleContext?: unknown): string[];
	render(width: number): string[];
	invalidate(): void;
	handleMouse?(event: MouseEvent): MouseResult | undefined;
}

interface Button {
	text: string;
	index: number;
	row: number;
	start: number;
	end: number;
}

interface RenderState {
	buttons: Button[];
	results: Map<number, string>;
}

const PATCH = Symbol.for("pi.code-block-copy-button");
const FENCE_LABEL = new RegExp(`\`\`\`\\S*\\s+(${[COPY_LABEL, COPIED_LABEL, FAILED_LABEL].join("|")})\\s*$`);

/** Install once per Markdown class. Return undefined if Pi changed the members that the patch uses. */
export function installCodeBlockCopyButton(
	markdown: unknown,
	copy: (text: string) => void | Promise<void>,
	requestRender: () => void,
): (() => void) | undefined {
	const prototype = (markdown as { prototype?: MarkdownLike } | undefined)?.prototype;
	if (!prototype || typeof prototype.renderToken !== "function" || typeof prototype.render !== "function"
		|| typeof prototype.invalidate !== "function") {
		return undefined;
	}
	const properties = prototype as unknown as Record<PropertyKey, unknown>;
	// A reload replaces the old patch, rather than adding another wrapper.
	if (typeof properties[PATCH] === "function") (properties[PATCH] as () => void)();

	const originalRenderToken = prototype.renderToken;
	const originalRender = prototype.render;
	const renderDescriptor = Object.getOwnPropertyDescriptor(prototype, "render");
	const tokenDescriptor = Object.getOwnPropertyDescriptor(prototype, "renderToken");
	const mouseDescriptor = Object.getOwnPropertyDescriptor(prototype, "handleMouse");
	const states = new WeakMap<object, RenderState>();
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let active = true;
	let pending: string[] | undefined;

	function stateOf(markdown: object): RenderState {
		let state = states.get(markdown);
		if (!state) states.set(markdown, state = { buttons: [], results: new Map() });
		return state;
	}

	function renderToken(this: MarkdownLike, token: Token, ...rest: [number, string?, unknown?]): string[] {
		const lines = originalRenderToken.call(this, token, ...rest);
		if (!active || !pending || token.type !== "code" || typeof token.text !== "string" || lines.length === 0) {
			return lines;
		}
		const label = states.get(this)?.results.get(pending.length) ?? COPY_LABEL;
		pending.push(token.text);
		lines[0] += `  ${this.theme.link(label)}`;
		return lines;
	}

	function render(this: MarkdownLike, width: number): string[] {
		if (!active) return originalRender.call(this, width);
		const cached = this.cachedLines;
		const outer = pending;
		pending = [];
		try {
			const lines = originalRender.call(this, width);
			// A cache hit does not render tokens again, so keep the buttons from the last real render.
			if (lines === cached && states.has(this)) return lines;
			const texts = pending;
			const found: Button[] = [];
			lines.forEach((line, row) => {
				const matched = FENCE_LABEL.exec(stripTerminalSequences(line));
				if (!matched) return;
				const plain = stripTerminalSequences(line).trimEnd();
				const start = visibleWidth(plain.slice(0, plain.length - matched[1].length));
				found.push({ text: "", index: found.length, row, start, end: start + visibleWidth(matched[1]) });
			});
			// Labels and blocks are in the same order. If the counts differ, a code line fooled the match.
			if (found.length === texts.length) found.forEach((button, index) => { button.text = texts[index]; });
			stateOf(this).buttons = found.length === texts.length ? found : [];
			return lines;
		} finally {
			pending = outer;
		}
	}

	function showResult(markdown: MarkdownLike, index: number, label: string): void {
		const results = stateOf(markdown).results;
		results.set(index, label);
		markdown.invalidate();
		requestRender();
		const timer = setTimeout(() => {
			timers.delete(timer);
			// A newer click on the same block owns the label.
			if (results.get(index) !== label) return;
			results.delete(index);
			markdown.invalidate();
			requestRender();
		}, RESULT_MS);
		timers.add(timer);
	}

	function handleMouse(this: MarkdownLike, event: MouseEvent): MouseResult | undefined {
		if (!active || event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		const hit = states.get(this)?.buttons.find((button) =>
			button.row === event.y && event.x >= button.start - 1 && event.x <= button.end);
		if (!hit) return undefined;
		// The press is handled too, so Pi does not start a text selection.
		if (event.type === "click") {
			new Promise<void>((resolve) => resolve(copy(hit.text))).then(
				() => active && showResult(this, hit.index, COPIED_LABEL),
				() => active && showResult(this, hit.index, FAILED_LABEL),
			);
		}
		return { handled: true };
	}

	function restore(): void {
		active = false;
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
		const put = (name: string, descriptor: PropertyDescriptor | undefined, current: unknown, mine: unknown) => {
			if (current !== mine) return;
			if (descriptor) Object.defineProperty(prototype, name, descriptor);
			else delete properties[name];
		};
		put("render", renderDescriptor, prototype.render, render);
		put("renderToken", tokenDescriptor, prototype.renderToken, renderToken);
		put("handleMouse", mouseDescriptor, prototype.handleMouse, handleMouse);
		if (properties[PATCH] === restore) delete properties[PATCH];
	}

	prototype.renderToken = renderToken as MarkdownLike["renderToken"];
	prototype.render = render;
	prototype.handleMouse = handleMouse;
	properties[PATCH] = restore;
	return restore;
}
