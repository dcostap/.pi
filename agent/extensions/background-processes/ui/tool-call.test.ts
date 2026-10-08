import { describe, expect, test } from "bun:test";
import type { ProcessView } from "../formatting.ts";
import { BACKGROUND_NOTICE_MARKER } from "../prompt.ts";
import {
	renderBackgroundCompletionMessage,
	renderBackgroundToolCall,
	renderBackgroundToolResult,
} from "./tool-call.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

function view(overrides: Partial<ProcessView> = {}): ProcessView {
	return {
		id: "bg-1",
		title: "Build",
		command: "bun run build",
		cwd: "C:/work",
		origin: "bash_bg_start",
		status: "done",
		settled: true,
		killRequested: false,
		exitCode: 0,
		createdAt: 0,
		settledAt: 2000,
		elapsedMs: 2000,
		capturedBytes: 300,
		droppedBytes: 0,
		totalLines: 30,
		preview: Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"),
		...overrides,
	};
}

const render = (component: { render(width: number): string[] }) => component.render(200).join("\n");
const collapsed = { expanded: false, isPartial: false };

describe("background tool calls", () => {
	test("bash_bg_start looks like a bash call with a background tag", () => {
		const text = render(renderBackgroundToolCall("bash_bg_start", { command: "bun test ./src", title: "Unit tests" }, theme));
		expect(text).toBe("$ <bash>bun test ./src</bash> (background · Unit tests)");
	});

	test("strips terminal control sequences and reuses the component", () => {
		const first = renderBackgroundToolCall("bash_bg_start", { command: "old", title: "Old" }, theme);
		const updated = renderBackgroundToolCall("bash_bg_start", { command: "safe\x1b]0;hidden\x07 command", title: "New\x1b[31m title" }, theme, first);
		expect(updated).toBe(first);
		expect(render(updated)).toBe("$ <bash>safe command</bash> (background · New title)");
	});

	test("other tools show a short label, ids, and live titles", () => {
		const lookup = (id: string) => (id === "bg-2" ? { title: "Dev server" } : undefined);
		expect(render(renderBackgroundToolCall("bash_bg_status", { id: "bg-2" }, theme, undefined, lookup))).toBe("bg status bg-2 Dev server");
		expect(render(renderBackgroundToolCall("bash_bg_status", {}, theme))).toBe("bg status all processes");
		expect(render(renderBackgroundToolCall("bash_bg_wait", { ids: ["bg-2", "bg-3"], timeout_seconds: 30 }, theme, undefined, lookup)))
			.toBe("bg wait bg-2 Dev server, bg-3 (timeout 30s)");
		expect(render(renderBackgroundToolCall("bash_bg_kill", { ids: ["bg-4"] }, theme))).toBe("bg stop bg-4");
	});
});

describe("background tool results", () => {
	test("a start that keeps running shows one line", () => {
		const result = { content: [{ type: "text", text: "Started bg-3 (Dev) in C:/work. It is still running.\nlong hint" }], details: { process: view({ id: "bg-3", settled: false, status: "running", preview: "" }) } };
		expect(render(renderBackgroundToolResult("bash_bg_start", result, collapsed, theme))).toBe("\n→ running in background as bg-3");
	});

	test("status shows the newest output lines and a one-line footer", () => {
		const result = { content: [{ type: "text", text: "bg-1 — Build\nState: done\n..." }], details: { process: view() } };
		const text = render(renderBackgroundToolResult("bash_bg_status", result, collapsed, theme));

		expect(text).toContain("line 30");
		expect(text).toContain("... (25 earlier lines, ctrl+e to expand)");
		expect(text).not.toContain("line 25\n");
		expect(text).toContain("✓ exit 0 · 2s · 300B");
		expect(text).not.toContain("State:");
	});

	test("expanded results show the full model text without the guidance notice", () => {
		const result = { content: [{ type: "text", text: `full text\n\n${BACKGROUND_NOTICE_MARKER}\nguidance` }], details: { process: view() } };
		const text = render(renderBackgroundToolResult("bash_bg_status", result, { expanded: true, isPartial: false }, theme));
		expect(text).toBe("\nfull text");
	});

	test("a timed-out wait names the processes that still run", () => {
		const result = {
			content: [{ type: "text", text: "Wait timed out." }],
			details: { processes: [view({ settled: false, status: "running", exitCode: undefined })], timedOut: true, timeoutSeconds: 60 },
		};
		const text = render(renderBackgroundToolResult("bash_bg_wait", result, collapsed, theme));
		expect(text).toContain("● running · 2s");
		expect(text).toContain("wait timed out after 60s · still running: bg-1");
	});

	test("waits for several processes show one headline each", () => {
		const result = {
			content: [{ type: "text", text: "..." }],
			details: { processes: [view(), view({ id: "bg-2", title: "Lint", status: "failed", exitCode: 1, preview: "error" })] },
		};
		const text = render(renderBackgroundToolResult("bash_bg_wait", result, collapsed, theme));
		expect(text).toContain("✓ bg-1 Build · exit 0 · 2s");
		expect(text).toContain("✗ bg-2 Lint · exit 1 · 2s");
	});

	test("the list shows one line per process", () => {
		const result = { content: [{ type: "text", text: "..." }], details: { processes: [view({ preview: undefined }), view({ id: "bg-2", title: "Server", settled: false, status: "running" })], omitted: 0 } };
		const text = render(renderBackgroundToolResult("bash_bg_status", result, collapsed, theme));
		expect(text).toBe("\n✓ bg-1 Build · exit 0 · 2s\n● bg-2 Server · running · 2s");
	});

	test("stop results show one line per process", () => {
		const result = { content: [{ type: "text", text: "..." }], details: { results: [{ outcome: "killed", process: view({ status: "killed", exitCode: null }) }] } };
		expect(render(renderBackgroundToolResult("bash_bg_kill", result, collapsed, theme))).toBe("\n■ bg-1 Build stopped");
	});

	test("results without structured details fall back to an output preview", () => {
		const result = { content: [{ type: "text", text: "old\nresult" }], details: { id: "bg-1" } };
		expect(render(renderBackgroundToolResult("bash_bg_status", result, collapsed, theme))).toBe("\nold\nresult");
	});

	test("errors render in full", () => {
		const result = { content: [{ type: "text", text: "Unknown background process ID: bg-9" }] };
		expect(render(renderBackgroundToolResult("bash_bg_status", result, collapsed, theme, undefined, true))).toBe("\nUnknown background process ID: bg-9");
	});
});

describe("automatic completion messages", () => {
	test("show a headline and the end of the output", () => {
		const message = { content: "A background process finished.\n\n---\n\nbg-1 — Build\nState: done", details: { processes: [view()] } };
		const text = render(renderBackgroundCompletionMessage(message, { expanded: false }, theme));

		expect(text).toContain("✓ bg-1 Build · finished · 2s");
		expect(text).toContain("line 30");
		expect(text).not.toContain("line 20\n");
		expect(text).not.toContain("State: done");
	});

	test("expanded messages show the text the agent received", () => {
		const message = { content: "A background process finished.\n\nbg-1 — Build\nState: done", details: { processes: [view()] } };
		const text = render(renderBackgroundCompletionMessage(message, { expanded: true }, theme));
		expect(text).toContain("State: done");
	});
});
