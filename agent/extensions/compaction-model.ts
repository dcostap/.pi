import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { streamSimple, type AssistantMessageEvent, type Usage } from "@earendil-works/pi-ai/compat";
import {
	compact,
	convertToLlm,
	type CompactionResult,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	type Focusable,
} from "@earendil-works/pi-tui";

const CONFIG_FILE = getConfigFile();
const VISIBLE_PICKER_ROWS = 12;
const SUMMARY_PROMPT_HEADROOM_TOKENS = 3_000;
const PROGRESS_WIDGET_KEY = "compaction-model-progress";
const PROGRESS_UPDATE_INTERVAL_MS = 250;
const FINAL_PROGRESS_HOLD_MS = 800;
const PROGRESS_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const USAGE = [
	"COMPACTION MODEL",
	"/compaction-model                 Open the model picker",
	"/compaction-model pick <search>   Open the picker with a search",
	"/compaction-model set provider/model (or set off)",
	"/compaction-model status",
	"/compaction-model off              Use Pi's normal current-model compaction",
	`Config: ${CONFIG_FILE}`,
].join("\n");

type ModelItem = {
	provider: string;
	id: string;
	model: any;
};

type CompactionModelConfig = {
	provider: string;
	model: string;
};

type CompactionProgress = {
	ctx: any;
	preparation: any;
	reason: string;
	model: string;
	contextWindow: number;
	estimatedInputTokens: number;
	startedAt: number;
	active: boolean;
	timer?: ReturnType<typeof setInterval>;
	finalClearTimer?: ReturnType<typeof setTimeout>;
	lastWidgetSignature?: string;
	spinnerIndex: number;
	requestCount: number;
	purposeIndex: number;
	currentPurpose: string;
	currentTerminal: "done" | "error" | undefined;
	currentPhase: string;
	currentOutputChars: number;
	currentThinkingChars: number;
	currentUsage?: Usage;
	currentError?: string;
};

function getConfigFile(): string {
	const baseDirectory =
		process.env.LOCALAPPDATA ??
		process.env.XDG_CONFIG_HOME ??
		join(homedir(), ".config");
	return join(baseDirectory, "pi", "compaction-model.json").replaceAll("\\", "/");
}

function modelLabel(config: Pick<CompactionModelConfig, "provider" | "model">): string {
	return `${config.provider}/${config.model}`;
}

function progressModelLabel(value: string): string {
	const separator = value.indexOf("/");
	if (separator <= 0) return value;
	return `${value.slice(separator + 1)} [${value.slice(0, separator)}]`;
}

function cleanString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function readConfig(): CompactionModelConfig | undefined {
	let raw: string;
	try {
		raw = readFileSync(CONFIG_FILE, "utf8");
	} catch (error: any) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}

	const parsed = JSON.parse(raw) as Record<string, unknown>;
	const provider = cleanString(parsed?.provider);
	const model = cleanString(parsed?.model);
	if (!provider || !model) {
		throw new Error(`Invalid compaction model configuration in ${CONFIG_FILE}`);
	}
	return { provider, model };
}

function writeConfig(config: CompactionModelConfig | undefined): void {
	if (!config) {
		rmSync(CONFIG_FILE, { force: true });
		return;
	}

	mkdirSync(dirname(CONFIG_FILE), { recursive: true });
	writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function parseProviderModel(value: string): Pick<CompactionModelConfig, "provider" | "model"> | undefined {
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash >= trimmed.length - 1) return undefined;
	return {
		provider: trimmed.slice(0, slash),
		model: trimmed.slice(slash + 1),
	};
}

function formatTokens(value: unknown): string {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "?";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
	return String(Math.round(value));
}

function formatCompactTokens(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value < 1_000) return String(Math.round(value));

	const thousands = value / 1_000;
	if (thousands < 10) return `${Number(thousands.toFixed(1))}k`;
	return `${Math.round(thousands)}k`;
}
function shortenText(value: string, maxLength: number): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, maxLength - 1)}…`;
}

function getProgressPurpose(preparation: any, purposeIndex: number): string {
	if (!preparation.isSplitTurn) return "history summary";
	if (preparation.messagesToSummarize.length > 0 && purposeIndex === 1) return "history summary";
	return "split-turn prefix";
}

function safeDeltaChars(delta: unknown): number {
	return typeof delta === "string" ? delta.length : 0;
}

function safeProgressChars(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

function estimateProgressTokens(charCount: number): number {
	return Math.ceil(safeProgressChars(charCount) / 4);
}

function progressContent(state: CompactionProgress, theme: Theme): string[] {
	const complete = state.currentTerminal === "done";
	const frame = complete
		? "✓"
		: PROGRESS_FRAMES[state.spinnerIndex % PROGRESS_FRAMES.length] ?? PROGRESS_FRAMES[0];
	const currentOutputEstimate = estimateProgressTokens(
		safeProgressChars(state.currentOutputChars) + safeProgressChars(state.currentThinkingChars),
	);
	const finalUsage = complete ? state.currentUsage : undefined;
	const currentOutput = finalUsage && Number.isFinite(finalUsage.output) && (finalUsage.output > 0 || currentOutputEstimate === 0)
		? finalUsage.output
		: currentOutputEstimate;
	const outputDisplay = currentOutput > 0
		? theme.fg("dim", ` · ↓${formatCompactTokens(currentOutput)}`)
		: "";
	const errorLine = state.currentError
		? theme.fg("warning", `⚠ ${shortenText(state.currentError, 100)}`)
		: undefined;

	return [
		`${theme.fg("accent", `${frame} ${theme.bold("Compaction")}`)}${outputDisplay}`,
		`${theme.fg("accent", progressModelLabel(state.model))} ${theme.fg("dim", "· reasoning off")}`,
		...(errorLine ? [errorLine] : []),
	];
}

function padToWidth(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function progressWidgetComponent(state: CompactionProgress, theme: Theme) {
	return {
		render(width: number): string[] {
			if (width < 8) return progressContent(state, theme).map((line) => truncateToWidth(line, width, ""));

			const contentWidth = Math.max(1, width - 4);
			const border = theme.fg("borderAccent", "│");
			const horizontal = theme.fg("borderAccent", "─".repeat(contentWidth + 2));
			const top = theme.fg("borderAccent", "╭") + horizontal + theme.fg("borderAccent", "╮");
			const bottom = theme.fg("borderAccent", "╰") + horizontal + theme.fg("borderAccent", "╯");
			const content = progressContent(state, theme).map(
				(line) => `${border} ${padToWidth(line, contentWidth)} ${border}`,
			);

			return [top, ...content, bottom];
		},
		invalidate() {},
	};
}

function setProgressWidget(state: CompactionProgress): void {
	if (!state.active || !state.ctx.hasUI || state.ctx.mode !== "tui") return;

	const signature = JSON.stringify([
		state.spinnerIndex,
		state.currentPhase,
		state.currentOutputChars,
		state.currentThinkingChars,
		state.currentUsage?.output,
		state.currentUsage?.input,
		state.currentError,
		state.requestCount,
	]);
	if (signature === state.lastWidgetSignature) return;
	state.lastWidgetSignature = signature;

	try {
		state.ctx.ui.setWidget(PROGRESS_WIDGET_KEY, (_tui: any, theme: Theme) => progressWidgetComponent(state, theme));
	} catch (error) {
		if (!(error instanceof Error) || !error.message.includes("This extension ctx is stale")) {
			console.error(error);
		}
	}
}

function createProgress(
	ctx: any,
	preparation: any,
	reason: string,
	model: any,
	modelName: string,
): CompactionProgress {
	const state: CompactionProgress = {
		ctx,
		preparation,
		reason,
		model: modelName,
		contextWindow: model.contextWindow ?? 0,
		estimatedInputTokens: estimateSummaryInputTokens(preparation),
		startedAt: Date.now(),
		active: true,
		spinnerIndex: 0,
		requestCount: 0,
		purposeIndex: 0,
		currentPurpose: "preparing",
		currentTerminal: undefined,
		currentPhase: "preparing summary request",
		currentOutputChars: 0,
		currentThinkingChars: 0,
	};

	if (ctx.hasUI && ctx.mode === "tui") {
		setProgressWidget(state);
		state.timer = setInterval(() => {
			state.spinnerIndex += 1;
			setProgressWidget(state);
		}, PROGRESS_UPDATE_INTERVAL_MS);
	}

	return state;
}

function handleProgressEvent(state: CompactionProgress, event: AssistantMessageEvent): void {
	switch (event.type) {
		case "start":
			state.currentPhase = `waiting for ${state.currentPurpose}`;
			break;
		case "text_delta":
			state.currentOutputChars += safeDeltaChars(event.delta);
			state.currentPhase = `streaming ${state.currentPurpose}`;
			break;
		case "thinking_delta":
			state.currentThinkingChars += safeDeltaChars(event.delta);
			state.currentPhase = `reasoning ${state.currentPurpose}`;
			break;
		case "done": {
			state.currentTerminal = "done";
			state.currentUsage = event.message.usage;
			state.currentPhase = `${state.currentPurpose} complete`;
			state.currentError = undefined;
			break;
		}
		case "error":
			state.currentTerminal = "error";
			state.currentUsage = event.error.usage;
			state.currentError = event.error.errorMessage || event.reason;
			state.currentPhase = `${state.currentPurpose} failed`;
			break;
		default:
			break;
	}

	setProgressWidget(state);
}

function createProgressStreamFn(state: CompactionProgress): any {
	return (model: any, context: any, options: any) => {
		const retrying = state.currentTerminal === "error";
		if (!retrying) state.purposeIndex += 1;
		state.currentPurpose = getProgressPurpose(state.preparation, state.purposeIndex);
		state.currentPhase = `${retrying ? "retrying" : "starting"} ${state.currentPurpose}`;
		state.requestCount += 1;
		state.currentOutputChars = 0;
		state.currentThinkingChars = 0;
		state.currentUsage = undefined;
		state.currentError = undefined;
		state.currentTerminal = undefined;
		setProgressWidget(state);

		let stream: any;
		try {
			stream = streamSimple(model, context, options);
		} catch (error) {
			state.currentTerminal = "error";
			state.currentPhase = `${state.currentPurpose} failed`;
			state.currentError = error instanceof Error ? error.message : String(error);
			setProgressWidget(state);
			throw error;
		}

		const push = stream.push.bind(stream);
		stream.push = (event: AssistantMessageEvent) => {
			handleProgressEvent(state, event);
			push(event);
		};
		return stream;
	};
}

function clearProgressWidget(state: CompactionProgress): void {
	state.active = false;
	state.finalClearTimer = undefined;
	if (!state.ctx.hasUI || state.ctx.mode !== "tui") return;
	try {
		state.ctx.ui.setWidget(PROGRESS_WIDGET_KEY, undefined);
	} catch (error) {
		if (!(error instanceof Error) || !error.message.includes("This extension ctx is stale")) {
			console.error(error);
		}
	}
}

function clearProgress(state: CompactionProgress | undefined, showFinal = false): void {
	if (!state) return;
	if (state.timer) clearInterval(state.timer);
	state.timer = undefined;
	if (state.finalClearTimer) clearTimeout(state.finalClearTimer);
	state.finalClearTimer = undefined;

	const showFinalWidget = showFinal && state.currentTerminal === "done" && state.ctx.hasUI && state.ctx.mode === "tui";
	if (showFinalWidget) {
		// Let the terminal render the provider's exact final usage before removing
		// the transient widget. This is short enough not to become a status panel.
		state.finalClearTimer = setTimeout(() => clearProgressWidget(state), FINAL_PROGRESS_HOLD_MS);
		return;
	}

	clearProgressWidget(state);
}

function modelSearchText(item: ModelItem): string {
	return `${item.provider}/${item.id} ${item.model.name ?? ""}`;
}

function sortModels(models: any[], current?: CompactionModelConfig): ModelItem[] {
	return models
		.map((model) => ({ provider: model.provider, id: model.id, model }))
		.sort((a, b) => {
			const aCurrent = current?.provider === a.provider && current.model === a.id;
			const bCurrent = current?.provider === b.provider && current.model === b.id;
			if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;

			const contextDifference = (b.model.contextWindow ?? 0) - (a.model.contextWindow ?? 0);
			if (contextDifference !== 0) return contextDifference;

			const provider = a.provider.localeCompare(b.provider);
			return provider !== 0 ? provider : a.id.localeCompare(b.id);
		});
}

class CompactionModelSelector extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private readonly allModels: ModelItem[];
	private filteredModels: ModelItem[];
	private selectedIndex = 0;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		private readonly theme: Theme,
		models: any[],
		initialQuery: string,
		private readonly current: CompactionModelConfig | undefined,
		private readonly done: (model: any | undefined) => void,
	) {
		super();
		this.allModels = sortModels(models, current);
		this.filteredModels = this.allModels;

		this.addChild(new Text(theme.fg("accent", theme.bold("Compaction model")), 0, 0));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					`Current: ${current ? modelLabel(current) : "off (Pi's current model)"}`,
				),
				0,
				0,
			),
		);
		this.addChild(
			new Text(
				theme.fg("dim", "The selected model summarizes old context; Pi's active model is unchanged."),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		if (initialQuery.trim()) this.searchInput.setValue(initialQuery.trim());
		this.searchInput.onSubmit = () => this.selectCurrent();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "↑↓ select • type to search • Enter save • Esc cancel"), 0, 0));

		this.filterModels(this.searchInput.getValue());
	}

	private filterModels(query: string): void {
		this.filteredModels = query ? fuzzyFilter(this.allModels, query, modelSearchText) : this.allModels;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(VISIBLE_PICKER_ROWS / 2),
				this.filteredModels.length - VISIBLE_PICKER_ROWS,
			),
		);
		const endIndex = Math.min(startIndex + VISIBLE_PICKER_ROWS, this.filteredModels.length);

		for (let i = startIndex; i < endIndex; i += 1) {
			const item = this.filteredModels[i];
			if (!item) continue;
			const selected = i === this.selectedIndex;
			const current = this.current?.provider === item.provider && this.current.model === item.id;
			const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
			const name = selected ? this.theme.fg("accent", item.id) : item.id;
			const provider = this.theme.fg("muted", ` [${item.provider}]`);
			const context = this.theme.fg("dim", ` ${formatTokens(item.model.contextWindow)} ctx`);
			const check = current ? this.theme.fg("success", " ✓") : "";
			this.listContainer.addChild(new Text(`${prefix}${name}${provider}${context}${check}`, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			this.listContainer.addChild(
				new Text(
					this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`),
					0,
					0,
				),
			);
		}

		if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching models"), 0, 0));
		}
	}

	private selectCurrent(): void {
		const selected = this.filteredModels[this.selectedIndex];
		if (selected) this.done(selected.model);
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "up")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (matchesKey(keyData, "down")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}
		if (
			keyData === "enter" ||
			keyData === "return" ||
			keyData === "\r" ||
			keyData === "\n" ||
			matchesKey(keyData, "enter") ||
			matchesKey(keyData, "return")
		) {
			this.selectCurrent();
			return;
		}
		if (keyData === "escape" || keyData === "\x1b" || matchesKey(keyData, "escape")) {
			this.done(undefined);
			return;
		}

		this.searchInput.handleInput(keyData);
		this.filterModels(this.searchInput.getValue());
	}
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function estimateSummaryInputTokens(preparation: any): number {
	const candidates: number[] = [];

	if (preparation.messagesToSummarize.length > 0) {
		const history = serializeConversation(convertToLlm(preparation.messagesToSummarize));
		const previous = preparation.previousSummary ?? "";
		candidates.push(estimateTextTokens(history) + estimateTextTokens(previous));
	}

	if (preparation.turnPrefixMessages.length > 0) {
		const prefix = serializeConversation(convertToLlm(preparation.turnPrefixMessages));
		candidates.push(estimateTextTokens(prefix));
	}

	return (candidates.length > 0 ? Math.max(...candidates) : 0) + SUMMARY_PROMPT_HEADROOM_TOKENS;
}

function getSummaryOutputBudget(preparation: any, model: any): number {
	const configured = Math.floor(0.8 * preparation.settings.reserveTokens);
	return model.maxTokens > 0 ? Math.min(configured, model.maxTokens) : configured;
}

function checkModelFits(preparation: any, model: any): { ok: true } | { ok: false; message: string } {
	const contextWindow = model.contextWindow ?? 0;
	if (contextWindow <= 0) return { ok: true };

	const inputTokens = estimateSummaryInputTokens(preparation);
	const outputTokens = getSummaryOutputBudget(preparation, model);
	const requiredTokens = inputTokens + outputTokens;
	if (requiredTokens <= contextWindow) return { ok: true };

	return {
		ok: false,
		message:
			`Configured model ${model.provider}/${model.id} may not fit this compaction ` +
			`(~${inputTokens.toLocaleString()} input + ${outputTokens.toLocaleString()} output > ` +
			`${contextWindow.toLocaleString()} context)`,
	};
}

function notifyFallback(ctx: any, reason: string, trigger: string, configuredModel?: string): void {
	const label = configuredModel ? ` (${configuredModel})` : "";
	ctx.ui.notify(
		`Compaction override skipped for ${trigger}${label}: ${reason}. Continuing with Pi's default compaction.`,
		"warning",
	);
}

async function saveModel(ctx: any, provider: string, modelId: string): Promise<void> {
	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) {
		ctx.ui.notify(`Compaction model not found: ${provider}/${modelId}`, "error");
		return;
	}

	const config = { provider: model.provider, model: model.id } satisfies CompactionModelConfig;
	await writeConfig(config);
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		ctx.ui.notify(
			`Compaction model saved but authentication is unavailable: ${modelLabel(config)}`,
			"warning",
		);
	} else {
		ctx.ui.notify(`Compaction model set to ${modelLabel(config)}`, "info");
	}
}

async function pickModel(ctx: any, initialQuery = ""): Promise<void> {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui.notify(USAGE, "error");
		return;
	}

	const models = ctx.modelRegistry.getAvailable();
	if (!models.length) {
		ctx.ui.notify("No authenticated models are available. Use /login or configure models.json.", "error");
		return;
	}

	const current = await readConfig();
	const selected = await ctx.ui.custom<any | undefined>(
		(_tui: any, theme: Theme, _keybindings: any, done: (model: any | undefined) => void) =>
			new CompactionModelSelector(theme, models, initialQuery, current, done),
	);
	if (!selected) return;

	await saveModel(ctx, selected.provider, selected.id);
}

async function showStatus(ctx: any): Promise<void> {
	try {
		const config = await readConfig();
		if (!config) {
			ctx.ui.notify("Compaction model override: OFF (Pi uses the currently selected model).", "info");
			return;
		}

		const model = ctx.modelRegistry.find(config.provider, config.model);
		if (!model) {
			ctx.ui.notify(`Compaction model is configured but not found: ${modelLabel(config)}`, "warning");
			return;
		}

		const authStatus = ctx.modelRegistry.hasConfiguredAuth(model)
			? "authentication configured"
			: "authentication unavailable";
		ctx.ui.notify(
			`Compaction model: ${modelLabel(config)} (${formatTokens(model.contextWindow)} context; ${authStatus}).`,
			ctx.modelRegistry.hasConfiguredAuth(model) ? "info" : "warning",
		);
	} catch (error) {
		ctx.ui.notify(`Could not read compaction model configuration: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

export default function compactionModelExtension(pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		let configuredModel: string | undefined;
		try {
			const config = readConfig();

			// No config means "off": let Pi run its normal current-model compaction.
			if (!config) return;

			configuredModel = modelLabel(config);
			const model = ctx.modelRegistry.find(config.provider, config.model);
			if (!model) {
				notifyFallback(ctx, "the configured model was not found", event.reason, configuredModel);
				return;
			}

			let auth;
			try {
				auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			} catch (error) {
				notifyFallback(
					ctx,
					`authentication resolution failed (${error instanceof Error ? error.message : String(error)})`,
					event.reason,
					configuredModel,
				);
				return;
			}
			if (!auth?.ok) {
				notifyFallback(ctx, `authentication is unavailable${auth?.error ? `: ${auth.error}` : ""}`, event.reason, configuredModel);
				return;
			}

			const fit = checkModelFits(event.preparation, model);
			if (!fit.ok) {
				notifyFallback(ctx, fit.message, event.reason, configuredModel);
				return;
			}

			const progress = createProgress(ctx, event.preparation, event.reason, model, configuredModel);
			let completed = false;
			try {
				const result = await compact(
					event.preparation,
					model,
					auth.apiKey,
					auth.headers,
					event.customInstructions,
					event.signal,
					"off",
					createProgressStreamFn(progress) as any,
					auth.env,
				);
				completed = true;
				return { compaction: result as CompactionResult };
			} finally {
				clearProgress(progress, completed);
			}
		} catch (error) {
			if (!event.signal.aborted) {
				notifyFallback(
					ctx,
					`the override request failed (${error instanceof Error ? error.message : String(error)})`,
					event.reason,
					configuredModel,
				);
			}
			return;
		}
	});

	pi.registerCommand("compaction-model", {
		description: "Configure the global model used for context compaction",
		getArgumentCompletions: (prefix) => {
			const options = ["pick", "set", "status", "off", "help"];
			const query = prefix.trim().toLowerCase();
			return options
				.filter((option) => option.startsWith(query))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			const command = (parts.shift() || "").toLowerCase();
			const rest = parts.join(" ");

			switch (command) {
			case "":
			case "pick":
				await pickModel(ctx, rest);
				return;
			case "set": {
				if (rest.toLowerCase() === "off") {
					writeConfig(undefined);
					ctx.ui.notify("Compaction model override disabled; Pi will use the current model.", "info");
					return;
				}
				const parsed = parseProviderModel(rest);
				if (!parsed) {
					ctx.ui.notify("Expected: /compaction-model set provider/model", "error");
					return;
				}
				await saveModel(ctx, parsed.provider, parsed.model);
				return;
			}
			case "off":
			case "clear":
				await writeConfig(undefined);
				ctx.ui.notify("Compaction model override disabled; Pi will use the current model.", "info");
				return;
			case "status":
				await showStatus(ctx);
				return;
			case "help":
			default:
				ctx.ui.notify(USAGE, "info");
				return;
		}
		},
	});
}
