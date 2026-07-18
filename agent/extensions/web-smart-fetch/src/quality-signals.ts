export type WeaknessOptions = {
	apiLike?: boolean;
	status?: number;
};

export function looksLikeHtml(text: string): boolean {
	const head = text.trimStart().slice(0, 2000);
	return /^<!doctype\s+html\b/i.test(head) || /<(?:html|head|body|main|article)\b/i.test(head);
}

export function resolveBodyContentType(actualContentType: string, text: string, expectedContentType?: string): string {
	const actual = actualContentType.trim().toLowerCase();
	if (looksLikeHtml(text) && (!actual || actual.startsWith("text/"))) return "text/html";
	if (actual) return actual;
	if (expectedContentType && !looksLikeHtml(text)) return expectedContentType.toLowerCase();
	return "text/html";
}

export function assessWeakness(text: string, html?: string, options: WeaknessOptions = {}): string[] {
	const reasons: string[] = [];
	const trimmed = text.trim();
	const htmlTitle = html?.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
	const lower = `${text}\n${htmlTitle}`.toLowerCase();

	if (typeof options.status === "number" && options.status >= 400) {
		reasons.push(`http-status-${options.status}`);
	}
	if (!trimmed) reasons.push("empty-content");
	if (!options.apiLike && trimmed && trimmed.length < 1200) reasons.push("too-short");
	if (html && html.trim().length < 800) reasons.push("html-too-short");

	for (const marker of [
		"verify you are human",
		"access denied",
		"enable javascript",
		"sign in to continue",
		"log in to continue",
		"subscribe to continue",
		"checking your browser",
		"captcha",
		"just a moment",
		"attention required",
		"cf-ray",
	]) {
		if (lower.includes(marker)) reasons.push(marker);
	}

	const boilerplateHits = ["cookie", "privacy policy", "terms of service", "all rights reserved"].filter((s) => lower.includes(s)).length;
	if (boilerplateHits >= 3 && text.length < 4000) reasons.push("boilerplate-heavy");
	if (html && /<script[^>]*>self\.__next_f\.push/i.test(html) && trimmed.length < 2000) reasons.push("next-rsc-shell");

	return [...new Set(reasons)];
}
