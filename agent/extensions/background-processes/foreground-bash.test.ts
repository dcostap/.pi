import { describe, expect, test } from "bun:test";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { WaitInterruptRegistry } from "../_shared/wait-interrupt.ts";
import { createForegroundBashTool, effectiveTimeoutSeconds } from "./foreground-bash.ts";
import { BackgroundProcessManager } from "./manager.ts";
import { BACKGROUND_NOTICE_MARKER, MAX_BLOCKING_SECONDS } from "./prompt.ts";

interface Execution {
	onData: (data: Buffer) => void;
	resolve: (value: { exitCode: number | null }) => void;
	env?: NodeJS.ProcessEnv;
	aborted: boolean;
}

class FakeOperations implements BashOperations {
	readonly executions = new Map<string, Execution>();

	exec(command: string, _cwd: string, options: { onData: (data: Buffer) => void; signal?: AbortSignal; env?: NodeJS.ProcessEnv }) {
		return new Promise<{ exitCode: number | null }>((resolve, reject) => {
			const execution: Execution = { onData: options.onData, resolve, env: options.env, aborted: false };
			this.executions.set(command, execution);
			options.signal?.addEventListener("abort", () => {
				execution.aborted = true;
				reject(new Error("aborted"));
			}, { once: true });
		});
	}

	output(command: string, text: string) {
		this.executions.get(command)!.onData(Buffer.from(text));
	}

	complete(command: string, exitCode = 0) {
		this.executions.get(command)!.resolve({ exitCode });
	}
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;

function setup() {
	const operations = new FakeOperations();
	const manager = new BackgroundProcessManager(operations, { persistFullOutput: false });
	const interrupts = new WaitInterruptRegistry();
	const tool = createForegroundBashTool({ manager: () => manager, interrupts });
	const ctx = { cwd: "C:/work" } as any;
	const run = (command: string, timeout?: number, signal?: AbortSignal) =>
		tool.execute("call-1", { command, timeout }, signal, undefined, ctx) as Promise<any>;
	return { operations, manager, interrupts, tool, run };
}

describe("foreground bash", () => {
	test("a command that finishes in time returns normally and is not tracked", async () => {
		const { operations, manager, run } = setup();
		const pending = run("echo hi", 5);
		await tick();
		operations.output("echo hi", "hi\n");
		operations.complete("echo hi");
		const result = await pending;

		expect(result.content[0].text).toBe("hi\n");
		expect(operations.executions.get("echo hi")!.env).toEqual({ PI_TEST: "1" });
		expect(manager.size).toBe(0);
	});

	test("a timeout moves the running command to the background instead of killing it", async () => {
		const { operations, manager, run } = setup();
		const pending = run("bun run build", 0.02);
		await tick();
		operations.output("bun run build", "compiling\n");
		const result = await pending;
		const text: string = result.content[0].text;

		expect(result.isError).toBeUndefined();
		expect(text).toStartWith("compiling");
		expect(text).toContain(BACKGROUND_NOTICE_MARKER);
		expect(text).toContain("moved to the background as bg-1");
		expect(text).toContain('bash_bg_wait with ids ["bg-1"]');
		expect(result.details.background).toEqual({ id: "bg-1", reason: "timeout", timeoutSeconds: 0.02 });
		expect(result.structuredContent).toMatchObject({ background_id: "bg-1", output: "compiling\n" });
		expect(operations.executions.get("bun run build")!.aborted).toBe(false);
		expect(manager.get("bg-1")).toMatchObject({ status: "running", origin: "bash-timeout", title: "bun run build" });

		operations.output("bun run build", "done\n");
		operations.complete("bun run build");
		await tick();
		expect(manager.get("bg-1")).toMatchObject({ status: "done", output: { text: "compiling\ndone\n" } });
		expect(manager.getDeferred().map((snapshot) => snapshot.id)).toEqual(["bg-1"]);
	});

	test("a steering message moves the running command to the background", async () => {
		const { manager, interrupts, run } = setup();
		const pending = run("bun test");
		await tick();
		interrupts.interruptForSteer();
		const result = await pending;

		expect(result.content[0].text).toContain("The user sent a message");
		expect(result.details.background).toMatchObject({ id: "bg-1", reason: "steer" });
		expect(manager.get("bg-1")).toMatchObject({ status: "running", origin: "bash-steer" });
	});

	test("cancellation still kills the command", async () => {
		const { operations, manager, run } = setup();
		const controller = new AbortController();
		const pending = run("sleep 100", undefined, controller.signal);
		await tick();
		controller.abort();

		await expect(pending).rejects.toThrow("Command aborted");
		expect(operations.executions.get("sleep 100")!.aborted).toBe(true);
		expect(manager.size).toBe(0);
	});

	test("timeouts are capped at eight minutes", () => {
		expect(effectiveTimeoutSeconds(undefined)).toBe(MAX_BLOCKING_SECONDS);
		expect(effectiveTimeoutSeconds(30)).toBe(30);
		expect(effectiveTimeoutSeconds(10_000)).toBe(MAX_BLOCKING_SECONDS);
		expect(() => effectiveTimeoutSeconds(0)).toThrow("Invalid timeout");
	});

	test("the transcript shows the output and the background ID, not the model guidance", () => {
		const { tool } = setup();
		const result = {
			content: [{ type: "text", text: `compiling\n\n${BACKGROUND_NOTICE_MARKER}\nlong guidance` }],
			details: { background: { id: "bg-4", reason: "timeout", timeoutSeconds: 480 } },
		};
		const rendered = (tool.renderResult as any)(result, { expanded: false, isPartial: false }, theme, {}).render(120).join("\n");

		expect(rendered).toContain("builtin:compiling");
		expect(rendered).not.toContain("long guidance");
		expect(rendered).toContain("→ moved to background as bg-4 · still running after 480s");
	});
});
