import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { registerAutocompact } from "./_shared/autocompact.ts";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
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
	type Focusable,
} from "@earendil-works/pi-tui";

const CONFIG_FILE = getConfigFile();
const VISIBLE_PICKER_ROWS = 12;
const SUMMARY_PROMPT_HEADROOM_TOKENS = 3_000;

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
	kind: "model";
	provider: string;
	id: string;
	model: any;
};

type OffItem = {
	kind: "off";
};

type PickerItem = ModelItem | OffItem;

type CompactionModelSelection =
	| { kind: "model"; model: any }
	| { kind: "off" };

type CompactionModelConfig = {
	provider: string;
	model: string;
};

type CompactionRequest = CompactionModelConfig & {
	thinkingLevel: ThinkingLevel;
	error?: string;
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

function modelSearchText(item: PickerItem): string {
	if (item.kind === "off") return "off disable current model default compaction";
	return `${item.provider}/${item.id} ${item.model.name ?? ""}`;
}

function sortModels(models: any[], current?: CompactionModelConfig): ModelItem[] {
	return models
		.map((model) => ({ kind: "model" as const, provider: model.provider, id: model.id, model }))
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
	private readonly allItems: PickerItem[];
	private filteredItems: PickerItem[];
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
		private readonly done: (selection: CompactionModelSelection | undefined) => void,
	) {
		super();
		const sortedModels = sortModels(models, current);
		const currentIndex = sortedModels.findIndex(
			(item) => current?.provider === item.provider && current.model === item.id,
		);
		this.allItems = currentIndex >= 0
			? [sortedModels[currentIndex]!, { kind: "off" }, ...sortedModels.filter((_, index) => index !== currentIndex)]
			: [{ kind: "off" }, ...sortedModels];
		this.filteredItems = this.allItems;

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
		this.filteredItems = query ? fuzzyFilter(this.allItems, query, modelSearchText) : this.allItems;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(VISIBLE_PICKER_ROWS / 2),
				this.filteredItems.length - VISIBLE_PICKER_ROWS,
			),
		);
		const endIndex = Math.min(startIndex + VISIBLE_PICKER_ROWS, this.filteredItems.length);

		for (let i = startIndex; i < endIndex; i += 1) {
			const item = this.filteredItems[i];
			if (!item) continue;
			const selected = i === this.selectedIndex;
			const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
			if (item.kind === "off") {
				const label = selected ? this.theme.fg("accent", "Off") : "Off";
				const description = this.theme.fg("muted", " — use Pi's current model");
				const check = !this.current ? this.theme.fg("success", " ✓") : "";
				this.listContainer.addChild(new Text(`${prefix}${label}${description}${check}`, 0, 0));
				continue;
			}

			const current = this.current?.provider === item.provider && this.current.model === item.id;
			const name = selected ? this.theme.fg("accent", item.id) : item.id;
			const provider = this.theme.fg("muted", ` [${item.provider}]`);
			const context = this.theme.fg("dim", ` ${formatTokens(item.model.contextWindow)} ctx`);
			const check = current ? this.theme.fg("success", " ✓") : "";
			this.listContainer.addChild(new Text(`${prefix}${name}${provider}${context}${check}`, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			this.listContainer.addChild(
				new Text(
					this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`),
					0,
					0,
				),
			);
		}

		if (this.filteredItems.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching models"), 0, 0));
		}
	}

	private selectCurrent(): void {
		const selected = this.filteredItems[this.selectedIndex];
		if (!selected) return;
		this.done(selected.kind === "off" ? { kind: "off" } : { kind: "model", model: selected.model });
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "up")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (matchesKey(keyData, "down")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
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
	const current = await readConfig();
	const selected = await ctx.ui.custom<CompactionModelSelection | undefined>(
		(_tui: any, theme: Theme, _keybindings: any, done: (selection: CompactionModelSelection | undefined) => void) =>
			new CompactionModelSelector(theme, models, initialQuery, current, done),
	);
	if (!selected) return;

	if (selected.kind === "off") {
		writeConfig(undefined);
		ctx.ui.notify("Compaction model override disabled; Pi will use the current model.", "info");
		return;
	}

	await saveModel(ctx, selected.model.provider, selected.model.id);
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
	const blockAutomaticCompaction = registerAutocompact(pi);
	let commandActive = false;
	let oneShot: CompactionRequest | undefined;

	pi.registerCommand("compact-with-model", {
		description: "Pick a model for one compaction without changing the chat model; optional summary instructions",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/compact-with-model needs a model picker. Use interactive or RPC mode.", "error");
				return;
			}
			if (commandActive || !ctx.isIdle()) {
				ctx.ui.notify("Wait for the current operation to finish before compacting.", "warning");
				return;
			}

			commandActive = true;
			try {
				const models = ctx.scopedModels.length > 0
					? ctx.scopedModels.map((item) => item.model)
					: ctx.modelRegistry.getAvailable();
				if (models.length === 0) {
					ctx.ui.notify("No models are available. Use /login to add a provider.", "warning");
					return;
				}
				const labels = models.map((model) => `${model.provider}/${model.id}`);
				const selected = await ctx.ui.select("Compact once with model (chat model stays unchanged)", labels);
				if (selected === undefined) return;
				if (!ctx.isIdle()) {
					ctx.ui.notify("The session is busy. Run /compact-with-model again when it is idle.", "warning");
					return;
				}
				const model = models[labels.indexOf(selected)];
				if (!model) return;
				const settings = pi.getSettings();
				const scoped = ctx.scopedModels.find(
					(item) => item.model.provider === model.provider && item.model.id === model.id,
				);
				const thinkingLevel = clampThinkingLevel(
					model,
					scoped?.thinkingLevel ?? settings.modelThinkingLevels?.[selected] ?? settings.defaultThinkingLevel ?? "medium",
				) as ThinkingLevel;
				const request: CompactionRequest = { provider: model.provider, model: model.id, thinkingLevel };
				oneShot = request;
				const error = await new Promise<Error | undefined>((resolve) => {
					ctx.compact({
						customInstructions: args.trim() || undefined,
						onComplete: () => resolve(undefined),
						onError: resolve,
					});
				});
				if (error) {
					ctx.ui.notify(`Compaction with ${selected} failed: ${request.error ?? error.message}`, "error");
				} else {
					ctx.ui.notify(`Compacted with ${selected}. Chat model unchanged.`, "info");
				}
			} catch (error) {
				ctx.ui.notify(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				oneShot = undefined;
				commandActive = false;
			}
		},
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (blockAutomaticCompaction(event)) return { cancel: true };
		const request = event.reason === "manual" ? oneShot : undefined;
		let configuredModel: string | undefined;
		const fail = (reason: string) => {
			if (request) {
				request.error = reason;
				return { cancel: true as const };
			}
			notifyFallback(ctx, reason, event.reason, configuredModel);
			return undefined;
		};
		try {
			const config = request ?? readConfig();

			// No config means "off": let Pi run its normal current-model compaction.
			if (!config) return;

			configuredModel = modelLabel(config);
			const model = ctx.modelRegistry.find(config.provider, config.model);
			if (!model) {
				return fail("the selected model was not found");
			}

			let auth;
			try {
				auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			} catch (error) {
				return fail(
					`authentication resolution failed (${error instanceof Error ? error.message : String(error)})`,
				);
			}
			if (!auth?.ok) {
				return fail(`authentication is unavailable${auth?.error ? `: ${auth.error}` : ""}`);
			}

			const fit = checkModelFits(event.preparation, model);
			if (!fit.ok) {
				return fail(fit.message);
			}

			const thinkingLevel = request?.thinkingLevel ?? "off";
			// compaction-ui.ts shows this model in the "Compacting..." spinner.
			pi.events.emit("compaction:model", { model, thinkingLevel });
			const result = await compact(
				event.preparation,
				model,
				auth.apiKey,
				auth.headers,
				event.customInstructions,
				event.signal,
				thinkingLevel,
				ctx.modelRegistry.streamSimple.bind(ctx.modelRegistry),
				auth.env,
			);
			return { compaction: result as CompactionResult };
		} catch (error) {
			// A one-time selection must never fall back to the chat or global model.
			if (request) {
				return fail(event.signal.aborted ? "cancelled" : (error instanceof Error ? error.message : String(error)));
			}
			if (!event.signal.aborted) {
				return fail(`the override request failed (${error instanceof Error ? error.message : String(error)})`);
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
