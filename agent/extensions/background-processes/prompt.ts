export const BACKGROUND_PROCESS_PROMPT = `Use bash_bg_start for non-interactive bash commands such as servers, watchers, long builds, and long tests that can run independently. Use regular bash for quick commands whose result is needed immediately.

After bash_bg_start, continue useful work instead of polling. Use bash_bg_wait only when further progress truly depends on completion. A wait timeout or cancellation leaves the process running. Stop processes that are no longer needed and avoid duplicate servers or watchers.

A bash command launched with bash_bg_start must stay in the foreground from its shell's perspective. Do not append &, use start, Start-Process, nohup, daemon flags, or any other nested backgrounding mechanism. bash_bg_start itself supplies the background lifetime.

Background bash commands receive no stdin. Never use prompts, password requests, menus, REPLs, editors, or other interactive programs.`;

export function normalizeTitle(title: string): string {
	const normalized = title.replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
	return [...normalized].slice(0, 80).join("");
}
