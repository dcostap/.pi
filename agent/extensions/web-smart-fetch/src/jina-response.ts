export type JinaTargetMetadata = {
	status: number;
	finalUrl: string;
};

export function parseJinaTargetMetadata(text: string, targetUrl: string, proxyStatus: number): JinaTargetMetadata {
	const warningStatus = Number(text.match(/^Warning:\s*Target URL returned error\s+(\d{3})\b/im)?.[1] || 0);
	const sourceUrl = text.match(/^URL Source:\s*(https?:\/\/\S+)\s*$/im)?.[1]?.trim();
	return {
		status: warningStatus || proxyStatus,
		finalUrl: sourceUrl || targetUrl,
	};
}
