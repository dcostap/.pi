export type CodexSearchQuery = {
	q: string;
	recency?: number;
	domains?: string[];
};

export type CodexWebSearchParams = {
	search_query?: CodexSearchQuery[];
	open?: Array<{ ref_id: string; lineno?: number }>;
	click?: Array<{ ref_id: string; id: number }>;
	find?: Array<{ ref_id: string; pattern: string }>;
	response_length?: "short" | "medium" | "long";
	settings?: { search_context_size?: "low" | "medium" | "high" };
};

export type CodexSearchRequest = {
	id: string;
	model: string;
	commands: Omit<CodexWebSearchParams, "settings">;
	settings: {
		search_context_size?: "low" | "medium" | "high";
		allowed_callers: ["direct"];
		external_web_access: true;
	};
	max_output_tokens: number;
};

export type SearchToolActivation = {
	activeTools: string[];
	firecrawlSearchDisplaced: boolean;
};

export function selectSearchTools(
	activeTools: string[],
	useCodexSearch: boolean,
	firecrawlSearchDisplaced: boolean,
): SearchToolActivation {
	const next = new Set(activeTools);
	let displaced = firecrawlSearchDisplaced;
	if (useCodexSearch) {
		next.add("codex_web_search");
		if (next.delete("firecrawl_search")) displaced = true;
	} else {
		next.delete("codex_web_search");
		if (displaced) next.add("firecrawl_search");
		displaced = false;
	}
	return { activeTools: [...next], firecrawlSearchDisplaced: displaced };
}

export function resolveCodexSearchUrl(baseUrl: string): string {
	const normalized = baseUrl.trim().replace(/\/+$/, "");
	if (!normalized) throw new Error("OpenAI Codex authentication did not provide a base URL");
	if (normalized.endsWith("/alpha/search")) return normalized;
	if (normalized.endsWith("/responses")) {
		return `${normalized.slice(0, -"/responses".length)}/alpha/search`;
	}
	if (
		normalized.endsWith("/api/codex") ||
		normalized.endsWith("/backend-api/codex") ||
		normalized.endsWith("/codex")
	) {
		return `${normalized}/alpha/search`;
	}
	if (normalized.endsWith("/api") || normalized.endsWith("/backend-api")) {
		return `${normalized}/codex/alpha/search`;
	}
	return `${normalized}/api/codex/alpha/search`;
}

export function buildCodexSearchRequest(
	params: CodexWebSearchParams,
	id: string,
	model: string,
	maxOutputTokens = 2400,
): CodexSearchRequest {
	const { settings, ...commands } = params;
	const hasCommand = [commands.search_query, commands.open, commands.click, commands.find]
		.some((value) => Array.isArray(value) && value.length > 0);
	if (!hasCommand) {
		throw new Error("codex_web_search requires search_query, open, click, or find");
	}

	return {
		id,
		model,
		commands,
		settings: {
			...(settings?.search_context_size
				? { search_context_size: settings.search_context_size }
				: {}),
			allowed_callers: ["direct"],
			external_web_access: true,
		},
		max_output_tokens: maxOutputTokens,
	};
}

export function getHeader(headers: Record<string, unknown> | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const target = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === target && typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

export function accountIdFromToken(token: string): string | undefined {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		const accountId =
			parsed?.["https://api.openai.com/auth"]?.chatgpt_account_id ||
			parsed?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
	} catch {
		return undefined;
	}
}
