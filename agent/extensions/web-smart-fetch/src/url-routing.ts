export type UrlHandler = "direct" | "github" | "youtube";

export type UrlResolution = {
	requestedUrl: string;
	canonicalUrl: string;
	fetchUrl: string;
	dedupeKey: string;
	adapterId: string;
	handler: UrlHandler;
	rewritten: boolean;
	expectedContentType?: string;
};

type UrlAdapter = {
	id: string;
	handler: UrlHandler;
	matches: (url: URL) => boolean;
	rewrite?: (url: URL) => { fetchUrl: URL; expectedContentType?: string };
};

function removeUnbalancedTrailingDelimiters(value: string): string {
	let result = value;
	for (const [open, close] of [["(", ")"], ["[", "]"]] as const) {
		while (result.endsWith(close)) {
			const opens = result.split(open).length - 1;
			const closes = result.split(close).length - 1;
			if (closes <= opens) break;
			result = result.slice(0, -1).trimEnd();
		}
	}
	return result;
}

export function sanitizeUrlCandidate(input: unknown): string {
	let value = String(input ?? "").trim();
	if (!value) return "";

	if (value.startsWith("<") && value.endsWith(">")) {
		value = value.slice(1, -1).trim();
	}

	value = value.replace(/^[\s("'`\[]+/, "");
	for (let i = 0; i < 3; i += 1) {
		let next = value
			.replace(/(?:\*{1,3}|_{1,3}|`{1,3})+$/g, "")
			.replace(/[>"'`]+$/g, "")
			.trim();
		const withoutSentencePunctuation = next.replace(/[.,;:]+$/g, "");
		if (withoutSentencePunctuation !== next) {
			const withoutUnbalancedClosers = removeUnbalancedTrailingDelimiters(withoutSentencePunctuation);
			if (withoutUnbalancedClosers !== withoutSentencePunctuation) next = withoutUnbalancedClosers;
		}
		next = removeUnbalancedTrailingDelimiters(next);
		if (next === value) break;
		value = next;
	}

	return value;
}

export function normalizeUrl(input: unknown): string {
	const sanitized = sanitizeUrlCandidate(input);
	if (!sanitized) throw new Error("URL is required");

	const candidate = /^[a-z][a-z\d+.-]*:/i.test(sanitized) ? sanitized : `https://${sanitized}`;
	const url = new URL(candidate);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Unsupported URL protocol: ${url.protocol}`);
	}
	if (!url.hostname) throw new Error("URL must include a hostname");
	if (url.username || url.password) throw new Error("URL credentials are not allowed");

	url.hash = "";
	if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
		url.port = "";
	}
	return url.toString();
}

export function urlDedupeKey(input: unknown): string {
	const url = new URL(normalizeUrl(input));
	if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
	return url.toString();
}

function host(url: URL): string {
	return url.hostname.replace(/^www\./, "").toLowerCase();
}

const adapters: readonly UrlAdapter[] = [
	{
		id: "github",
		handler: "github",
		matches: (url) => host(url) === "github.com" || host(url) === "raw.githubusercontent.com",
	},
	{
		id: "youtube-captions",
		handler: "youtube",
		matches: (url) => ["youtube.com", "m.youtube.com", "youtu.be"].includes(host(url)),
	},
	{
		id: "apple-docs-sosumi",
		handler: "direct",
		matches: (url) => {
			if (host(url) !== "developer.apple.com") return false;
			return ["/documentation", "/design/human-interface-guidelines", "/videos/play"]
				.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
		},
		rewrite: (url) => {
			const rewritten = new URL(url.toString());
			rewritten.protocol = "https:";
			rewritten.hostname = "sosumi.ai";
			rewritten.port = "";
			rewritten.username = "";
			rewritten.password = "";
			// Never forward arbitrary canonical-site query values to a different origin.
			rewritten.search = "";
			return { fetchUrl: rewritten, expectedContentType: "text/markdown" };
		},
	},
];

export function resolveUrl(input: unknown): UrlResolution {
	const requestedUrl = String(input ?? "");
	const canonicalUrl = normalizeUrl(input);
	const canonical = new URL(canonicalUrl);
	const adapter = adapters.find((candidate) => candidate.matches(canonical));
	const rewritten = adapter?.rewrite?.(new URL(canonical.toString()));
	const fetchUrl = rewritten?.fetchUrl.toString() || canonicalUrl;

	return {
		requestedUrl,
		canonicalUrl,
		fetchUrl,
		dedupeKey: urlDedupeKey(canonicalUrl),
		adapterId: adapter?.id || "default",
		handler: adapter?.handler || "direct",
		rewritten: fetchUrl !== canonicalUrl,
		expectedContentType: rewritten?.expectedContentType,
	};
}
