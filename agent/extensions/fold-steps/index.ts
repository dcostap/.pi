import {
	AssistantMessageComponent, SkillInvocationMessageComponent, ToolExecutionComponent, UserMessageComponent,
	type ExtensionAPI, type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container, MouseRegion, Spacer, truncateToWidth, type Component, type TuiMouseEvent,
} from "@earendil-works/pi-tui";

// Pi has no transcript grouping API. This extension replaces the render of Pi's chat container,
// and of each assistant message's content container, so that it can skip steps and add fold lines.
// Container.handleMouse uses the layout that render records, so clicks reach the fold lines.

type Layout = { width: number; children: { component: Component; height: number }[] };
type Box = Container & { mouseLayout?: Layout };
type Assistant = AssistantMessageComponent & {
	contentContainer: Box;
	isStreaming: boolean;
	outputPad: number;
	lastMessage?: { stopReason?: string; content: { type: string; text?: string }[] };
};
type Tui = { children: Component[]; mode?: string; requestRender(): void };
type Plan = { hidden: Set<Component>; folds: Map<Component, FoldLine> };
type Piece = { component: Component; box: Box; owner: Component; index: number };
type Kind = "step" | "glue" | "other";

const baseRender = Container.prototype.render;
const WIDGET = "fold-steps";

/** Expanded folds, keyed by the first step: its chat child and its index in that child (-1 for the child). */
const expanded = new WeakMap<Component, Set<number>>();
let plans = new WeakMap<Box, Plan>();
let showAll = false;

function planFor(box: Box): Plan {
	let plan = plans.get(box);
	if (!plan) plans.set(box, plan = { hidden: new Set(), folds: new Map() });
	return plan;
}

function renderPlanned(this: Box, width: number): string[] {
	const plan = plans.get(this);
	if (!plan) return baseRender.call(this, width);
	const lines: string[] = [];
	const children: Layout["children"] = [];
	const add = (component: Component) => {
		const rendered = component.render(width);
		children.push({ component, height: rendered.length });
		lines.push(...rendered);
	};
	for (const child of this.children) {
		const fold = plan.folds.get(child);
		if (fold) add(fold);
		if (!plan.hidden.has(child)) add(child);
	}
	this.mouseLayout = { width, children };
	return lines;
}

class FoldLine implements Component {
	constructor(
		private tui: Tui, private theme: Theme, private piece: Piece,
		private steps: number, private open: boolean, private blank: boolean, private pad: number,
	) {}

	render(width: number): string[] {
		const label = `${this.open ? "▾" : "▸"} ${this.steps} step${this.steps === 1 ? "" : "s"}`;
		const line = truncateToWidth(" ".repeat(this.pad) + this.theme.fg("muted", label), width);
		return this.blank ? ["", line] : [line];
	}

	handleMouse(event: TuiMouseEvent) {
		if (event.type !== "click" || event.button !== "left" || (this.blank && event.y === 0)) return undefined;
		const { owner, index } = this.piece;
		const open = expanded.get(owner) ?? new Set<number>();
		if (open.has(index)) open.delete(index);
		else open.add(index);
		expanded.set(owner, open);
		this.tui.requestRender();
		return { handled: true };
	}

	invalidate() {}
}

/** Only a turn that ended with a final answer folds. A running, cancelled, or failed turn stays open. */
function finished(turn: Component[]): Assistant | undefined {
	const last = turn.findLast((child) => child instanceof AssistantMessageComponent) as Assistant | undefined;
	const message = last?.lastMessage;
	if (!last || last.isStreaming || message?.stopReason !== "stop") return;
	return message.content.some((part) => part.type === "text" && part.text?.trim()) ? last : undefined;
}

function kind(component: Component, inAssistant: boolean): Kind {
	if (component instanceof Spacer) return "glue";
	if (component instanceof ToolExecutionComponent) return "step";
	// Pi wraps each thinking block in a MouseRegion. Assistant text is Markdown.
	if (inAssistant && component instanceof MouseRegion) return "step";
	return "other";
}

/** Flatten a turn: assistant messages contribute their content blocks, so thinking can fold with tools. */
function pieces(turn: Component[], chat: Box): (Piece & { kind: Kind })[] {
	return turn.flatMap((owner) => {
		if (!(owner instanceof AssistantMessageComponent)) {
			return [{ component: owner, box: chat, owner, index: -1, kind: kind(owner, false) }];
		}
		const box = (owner as Assistant).contentContainer;
		box.render = renderPlanned;
		return box.children.map((component, index) => ({ component, box, owner, index, kind: kind(component, true) }));
	});
}

function planTurn(tui: Tui, theme: Theme, chat: Box, turn: Component[]): void {
	const last = finished(turn);
	if (!last) return;
	const flat = pieces(turn, chat);
	let start = -1;
	let end = -1;
	const close = () => {
		if (start < 0) return;
		const run = flat.slice(start, end + 1);
		const first = run[0]!;
		const open = expanded.get(first.owner)?.has(first.index) ?? false;
		const steps = run.filter((piece) => piece.kind === "step").length;
		// Tool components start with their own blank line; thinking follows a spacer in its message.
		const fold = new FoldLine(tui, theme, first, steps, open, first.box === chat, last.outputPad ?? 1);
		planFor(first.box).folds.set(first.component, fold);
		if (!open) for (const piece of run) planFor(piece.box).hidden.add(piece.component);
		start = -1;
	};
	flat.forEach((piece, index) => {
		if (piece.kind === "step") {
			if (start < 0) start = index;
			end = index;
		} else if (piece.kind === "other") close();
	});
	close();
}

function renderChat(tui: Tui, theme: Theme, chat: Box, width: number): string[] {
	plans = new WeakMap();
	if (!showAll && tui.mode === "fullscreen") {
		let turn: Component[] | undefined;
		for (const child of chat.children) {
			if (child instanceof UserMessageComponent || child instanceof SkillInvocationMessageComponent) {
				if (turn) planTurn(tui, theme, chat, turn);
				turn = [];
			}
			turn?.push(child);
		}
		if (turn) planTurn(tui, theme, chat, turn);
	}
	return renderPlanned.call(chat, width);
}

/** Pi's document holds the header, the loaded resources, and the chat, in that order. */
function findChat(tui: Tui): Box | undefined {
	const document = tui.children[0];
	if (!(document instanceof Container) || document.children.length !== 3) return;
	const chat = document.children[2];
	return chat instanceof Container ? chat : undefined;
}

export default function foldSteps(pi: ExtensionAPI) {
	let restore: (() => void) | undefined;
	let current: Tui | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		restore?.();
		// A widget factory is the only place where an extension receives the TUI without user input.
		ctx.ui.setWidget(WIDGET, (tui, theme) => {
			const chat = findChat(tui as unknown as Tui);
			if (chat) {
				current = tui as unknown as Tui;
				chat.render = (width) => renderChat(current!, theme, chat, width);
				restore = () => {
					delete (chat as { render?: unknown }).render;
					plans = new WeakMap();
					current = undefined;
				};
			}
			return { render: () => [], invalidate() {} };
		});
		ctx.ui.setWidget(WIDGET, undefined);
		if (!restore) ctx.ui.notify("Step folding is not compatible with this Pi version.", "warning");
	});

	pi.on("session_shutdown", () => {
		restore?.();
		restore = undefined;
	});

	pi.registerShortcut("alt+o", {
		description: "Show or hide folded steps in all turns",
		handler: () => {
			showAll = !showAll;
			current?.requestRender();
		},
	});
}
