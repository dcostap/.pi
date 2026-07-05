import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, matchesKey, Spacer, Text, type Focusable } from "@earendil-works/pi-tui";
import {
	FAST_CHEAP_ROLE,
	MODEL_ROLES_FILE,
	getModelRoleConfig,
	modelLabel,
	resolveModelRole,
	writeModelRole,
	type ModelRoleConfig,
} from "./_shared/model-roles";

const VISIBLE_PICKER_ROWS = 10;
const DEFAULT_REASONING_EFFORT = "minimal";
const DEFAULT_MAX_TOKENS = 2048;
const FAST_CHEAP_HINTS = [
	"spark",
	"flash",
	"lite",
	"mini",
	"small",
	"haiku",
	"instant",
	"fast",
	"cheap",
	"8b",
	"7b",
	"4o-mini",
	"4.1-mini",
];

type ModelItem = {
	provider: string;
	id: string;
	model: any;
};

function defaultRoleConfig(config: Pick<ModelRoleConfig, "provider" | "model">): ModelRoleConfig {
	return { ...config, reasoningEffort: DEFAULT_REASONING_EFFORT, maxTokens: DEFAULT_MAX_TOKENS };
}

function parseProviderModel(value: string): Pick<ModelRoleConfig, "provider" | "model"> | undefined {
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash >= trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

function usage(): string {
	return [
		"FAST CHEAP MODEL CONFIGURATION",
		"/fast-model                 OPEN SEARCHABLE MODEL PICKER",
		"/fast-model pick <search>   OPEN PICKER WITH INITIAL SEARCH",
		"/fast-model set provider/model",
		"/fast-model status",
		"/fast-model clear",
		`Local file: ${MODEL_ROLES_FILE}`,
	].join("\n");
}

function searchText(item: ModelItem): string {
	return `${item.provider}/${item.id} ${item.model.name ?? ""}`;
}

function scoreModel(item: ModelItem, current?: ModelRoleConfig): number {
	const text = searchText(item).toLowerCase();
	let score = 0;
	if (current?.provider === item.provider && current.model === item.id) score += 10_000;
	for (const hint of FAST_CHEAP_HINTS) {
		if (text.includes(hint)) score += 50;
	}
	if (text.includes("preview")) score -= 10;
	if (text.includes("thinking") || text.includes("reasoning")) score -= 10;
	return score;
}

function sortModels(models: any[], current?: ModelRoleConfig): ModelItem[] {
	return models
		.map((model) => ({ provider: model.provider, id: model.id, model }))
		.sort((a, b) => {
			const score = scoreModel(b, current) - scoreModel(a, current);
			if (score !== 0) return score;
			const provider = a.provider.localeCompare(b.provider);
			if (provider !== 0) return provider;
			return a.id.localeCompare(b.id);
		});
}

async function notifyStatus(ctx: any) {
	const resolved = await resolveModelRole(ctx, FAST_CHEAP_ROLE);
	if (resolved.ok) {
		ctx.ui.notify(`FAST CHEAP MODEL IS ${resolved.label}`, "info");
		return;
	}
	ctx.ui.notify(resolved.loudMessage, "error");
}

async function saveConfig(ctx: any, config: ModelRoleConfig) {
	const found = ctx.modelRegistry.find(config.provider, config.model);
	if (!found) {
		ctx.ui.notify(`FAST CHEAP MODEL NOT SAVED: MODEL NOT FOUND: ${modelLabel(config)}`, "error");
		return;
	}

	await writeModelRole(FAST_CHEAP_ROLE, config);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(found);
	if (!auth?.ok) {
		ctx.ui.notify(
			`FAST CHEAP MODEL SAVED BUT NOT USABLE YET: ${modelLabel(config)}: ${String(auth?.error || "AUTH FAILED").toUpperCase()}`,
			"warning",
		);
		return;
	}
	ctx.ui.notify(`FAST CHEAP MODEL SAVED: ${found.provider}/${found.id}`, "info");
}

async function pickModel(ctx: any, rawQuery = "") {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui.notify(usage(), "error");
		return;
	}

	const models = ctx.modelRegistry.getAvailable();
	if (!models.length) {
		ctx.ui.notify("FAST CHEAP MODEL NOT CONFIGURED: NO AUTHENTICATED MODELS ARE AVAILABLE. USE /login OR EDIT models.json.", "error");
		return;
	}

	const current = await getModelRoleConfig(FAST_CHEAP_ROLE);
	const selected = await ctx.ui.custom<any | undefined>((_tui: any, theme: Theme, _keybindings: any, done: (model: any | undefined) => void) => {
		return new FastCheapModelSelector(theme, models, rawQuery, current, done);
	});
	if (!selected) return;
	await saveConfig(ctx, defaultRoleConfig({ provider: selected.provider, model: selected.id }));
}

class FastCheapModelSelector extends Container implements Focusable {
	private searchInput = new Input();
	private listContainer = new Container();
	private allModels: ModelItem[];
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
		private readonly current: ModelRoleConfig | undefined,
		private readonly done: (model: any | undefined) => void,
	) {
		super();
		this.allModels = sortModels(models, current);
		this.filteredModels = this.allModels;

		this.addChild(new Text(theme.fg("accent", theme.bold("Fast cheap model")), 0, 0));
		this.addChild(new Text(theme.fg("muted", `Current: ${current ? modelLabel(current) : "not configured"}`), 0, 0));
		this.addChild(new Text(theme.fg("dim", "Search like /model, then Enter to save for extension utility calls."), 0, 0));
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
		this.filteredModels = query
			? fuzzyFilter(this.allModels, query, searchText)
			: this.allModels;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		const maxVisible = VISIBLE_PICKER_ROWS;
		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

		for (let i = startIndex; i < endIndex; i += 1) {
			const item = this.filteredModels[i];
			if (!item) continue;
			const isSelected = i === this.selectedIndex;
			const isCurrent = this.current?.provider === item.provider && this.current.model === item.id;
			const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
			const modelText = isSelected ? this.theme.fg("accent", item.id) : item.id;
			const providerBadge = this.theme.fg("muted", ` [${item.provider}]`);
			const checkmark = isCurrent ? this.theme.fg("success", " ✓") : "";
			this.listContainer.addChild(new Text(`${prefix}${modelText}${providerBadge}${checkmark}`, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`), 0, 0));
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
		if (keyData === "enter" || keyData === "return" || keyData === "\r" || keyData === "\n" || matchesKey(keyData, "enter") || matchesKey(keyData, "return")) {
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

export default function fastModelExtension(pi: ExtensionAPI) {
	async function handler(args: string, ctx: any) {
		const [commandRaw, ...rest] = (args || "").trim().split(/\s+/).filter(Boolean);
		const command = (commandRaw || "").toLowerCase();

		if (!command) {
			await pickModel(ctx);
			return;
		}

		if (command === "status") {
			await notifyStatus(ctx);
			return;
		}

		if (command === "pick") {
			await pickModel(ctx, rest.join(" "));
			return;
		}

		if (command === "clear") {
			await writeModelRole(FAST_CHEAP_ROLE, undefined);
			ctx.ui.notify("FAST CHEAP MODEL CLEARED. EXTENSIONS THAT REQUIRE IT WILL STOP WITH A LOUD ERROR.", "warning");
			return;
		}

		if (command === "set") {
			const parsed = parseProviderModel(rest.join(" "));
			if (!parsed) {
				ctx.ui.notify("FAST CHEAP MODEL NOT SAVED: EXPECTED /fast-model set provider/model", "error");
				return;
			}
			await saveConfig(ctx, defaultRoleConfig(parsed));
			return;
		}

		ctx.ui.notify(usage(), "error");
	}

	pi.registerCommand("fast-model", {
		description: "Configure the per-machine fast cheap model used by extensions",
		handler,
	});
}
