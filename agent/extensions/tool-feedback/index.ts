import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { getAgentDir, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "tool_feedback",
		label: "Tool feedback",
		description:
			"Record a concrete tool problem, workaround, or missing capability observed during this task. " +
			"Describe what happened and what you expected. Suggestions are optional, not verified causes. " +
			"Do not repeat feedback within a session. Omit secrets, personal data, file contents, and copied tool output. " +
			"If saving fails, continue the task without retrying.",
		parameters: Type.Object({
			tool: Type.String({ minLength: 1, maxLength: 200, description: "Tool name, or the closest related tool." }),
			problem: Type.String({ minLength: 1, maxLength: 2000, description: "What happened and what you expected." }),
			impact: Type.String({ minLength: 1, maxLength: 1000, description: "How this affected the task." }),
			suggestion: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: "A possible improvement." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const directory = join(getAgentDir(), "feedback");
				const path = join(directory, "events.jsonl");
				const entry = {
					timestamp: new Date().toISOString(),
					sessionId: ctx.sessionManager.getSessionId(),
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					...params,
				};
				await withFileMutationQueue(path, async () => {
					await mkdir(directory, { recursive: true });
					await appendFile(path, JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600 });
				});
				return { content: [{ type: "text", text: "Feedback saved." }], details: undefined };
			} catch {
				return {
					content: [{ type: "text", text: "Feedback was not saved. Continue the task without retrying." }],
					details: undefined,
				};
			}
		},
	});
}
