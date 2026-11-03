import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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
	tokens?: Token[];
	items?: { tokens: Token[] }[];
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
	theme: { link: (text: string) => string; underline: (text: string) => string };
	cachedLines?: string[];
	cachedTokens?: WeakRef<{ tokens: Token[] }>;
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
	lines: string[];
}

const PATCH = Symbol.for("pi.code-block-copy-button");
const FENCE_LABEL = new RegExp(`\`\`\`\\S*\\s+(${[COPY_LABEL, COPIED_LABEL, FAILED_LABEL].join("|")})\\s*$`);

/** Install once per Markdown class. Return undefined if Pi changed the members that the patch uses. */
export function installCodeBlockCopyButton(
	markdown: unknown,
	copy: (text: string) => void | Promise<void>,
	requestRender: () => void,
	tui?: unknown,
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
	const inputHost = tui as { handleViewportInput?: (data: string) => unknown } | undefined;
	const originalInput = inputHost?.handleViewportInput;
	const inputDescriptor = inputHost && Object.getOwnPropertyDescriptor(inputHost, "handleViewportInput");
	let hovered: { markdown: MarkdownLike; index: number } | undefined;
	let hoverSeen = false;
	let active = true;

	function setHover(markdown?: MarkdownLike, index?: number): void {
		if (hovered?.markdown === markdown && hovered?.index === index) return;
		hovered?.markdown.invalidate();
		hovered = markdown && index !== undefined ? { markdown, index } : undefined;
		markdown?.invalidate();
		requestRender();
	}

	// Pi sends no leave event. Clear hover when input leaves the Markdown component,
	// scrolls the transcript, or removes terminal focus. Keep this private hook guarded.
	function handleViewportInput(this: unknown, data: string): unknown {
		hoverSeen = false;
		try {
			return originalInput!.call(this, data);
		} finally {
			if (!hoverSeen) setHover();
		}
	}

	function stateOf(markdown: object): RenderState {
		let state = states.get(markdown);
		if (!state) states.set(markdown, state = { buttons: [], results: new Map(), lines: [] });
		return state;
	}

	function renderToken(this: MarkdownLike, token: Token, ...rest: [number, string?, unknown?]): string[] {
		const lines = originalRenderToken.call(this, token, ...rest);
		if (!active || token.type !== "code" || typeof token.text !== "string" || lines.length === 0) {
			return lines;
		}
		// Keep cached blocks independent of their position and click result.
		lines[0] += `  ${this.theme.link(COPY_LABEL)}`;
		return lines;
	}

	function codeTexts(tokens: Token[]): string[] {
		return tokens.flatMap((token) => {
			if (token.type === "code" && typeof token.text === "string") return [token.text];
			if (token.type === "list") return (token.items ?? []).flatMap((item) => codeTexts(item.tokens));
			if (token.type === "blockquote") return codeTexts(token.tokens ?? []);
			return [];
		});
	}

	function render(this: MarkdownLike, width: number): string[] {
		if (!active) return originalRender.call(this, width);
		const cached = this.cachedLines;
		const baseLines = originalRender.call(this, width);
		const previous = states.get(this);
		if (baseLines === cached && previous) return previous.lines;
		// Pi can reuse some blocks without calling renderToken. Read all sources from its parsed tokens.
		const texts = codeTexts(this.cachedTokens?.deref()?.tokens ?? []);
		const state = stateOf(this);
		const lines = baseLines.slice();
		const found: Button[] = [];
		lines.forEach((line, row) => {
			const matched = FENCE_LABEL.exec(stripTerminalSequences(line));
			if (!matched) return;
			const plain = stripTerminalSequences(line).trimEnd();
			const start = visibleWidth(plain.slice(0, plain.length - matched[1].length));
			const index = found.length;
			const label = state.results.get(index) ?? COPY_LABEL;
			found.push({ text: "", index, row, start, end: start + visibleWidth(label) });
			const styledLabel = label === COPY_LABEL && hovered?.markdown === this && hovered.index === index
				? this.theme.underline(label) : label;
			// Do not change Pi's cached lines, which can also belong to another identical block.
			lines[row] = truncateToWidth(line.replace(COPY_LABEL, styledLabel), width, "");
		});
		// Labels and blocks are in the same order. If the counts differ, a code line fooled the match.
		if (found.length === texts.length) found.forEach((button, index) => { button.text = texts[index]; });
		state.buttons = found.length === texts.length ? found : [];
		state.lines = lines;
		return lines;
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
		if (!active) return undefined;
		const hit = states.get(this)?.buttons.find((button) =>
			button.row === event.y && event.x >= button.start - 1 && event.x <= button.end);
		if (event.type === "move") {
			hoverSeen = true;
			setHover(hit ? this : undefined, hit?.index);
			return hit ? { handled: true, render: false } : undefined;
		}
		if (hit && event.type !== "wheel" && hovered?.markdown === this && hovered.index === hit.index) hoverSeen = true;
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
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
		setHover();
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
		if (inputHost?.handleViewportInput === handleViewportInput) {
			if (inputDescriptor) Object.defineProperty(inputHost, "handleViewportInput", inputDescriptor);
			else delete inputHost.handleViewportInput;
		}
		if (properties[PATCH] === restore) delete properties[PATCH];
	}

	prototype.renderToken = renderToken as MarkdownLike["renderToken"];
	prototype.render = render;
	prototype.handleMouse = handleMouse;
	if (inputHost && typeof originalInput === "function") inputHost.handleViewportInput = handleViewportInput;
	properties[PATCH] = restore;
	return restore;
}
