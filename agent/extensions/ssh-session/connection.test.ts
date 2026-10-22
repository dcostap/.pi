import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

// No network connection or local OpenSSH process runs in these tests.
mock.module("node:child_process", () => ({
	spawnSync(command: string, args: string[]) {
		if (command !== "ssh") return { status: 1, stdout: "", stderr: "" };
		const [user, host] = args[1].split("@");
		return { status: 0, stdout: `user ${user}\nhostname ${host}\nport 22\n`, stderr: "" };
	},
}));

const clients: FakeClient[] = [];
class FakeClient extends EventEmitter {
	ended = false;
	constructor() {
		super();
		clients.push(this);
	}
	connect() { queueMicrotask(() => this.emit("ready")); }
	end() {
		this.ended = true;
		queueMicrotask(() => this.emit("close"));
	}
	exec(command: string, callback: (error: null, channel: EventEmitter & { stderr: EventEmitter }) => void) {
		const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
		callback(null, channel);
		queueMicrotask(() => {
			if (command.includes("pwd")) channel.emit("data", Buffer.from("/home/dario\n"));
			channel.emit("exit", 0);
			channel.emit("close");
		});
	}
}
mock.module("ssh2", () => ({ Client: FakeClient, utils: {} }));

let startRoot: () => Promise<unknown>;
mock.module("./root-shell.ts", () => ({ RootShell: { start: () => startRoot() } }));

const { default: sshSessionExtension } = await import("./index.ts");

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function harness(idle = false) {
	type Handler = (...args: any[]) => any;
	const commands = new Map<string, { handler: Handler }>();
	const handlers = new Map<string, Handler>();
	const messages: Array<{ message: any; options: any }> = [];
	const notices: string[] = [];
	let tool: any;
	const pi = {
		registerCommand(name: string, command: { handler: Handler }) { commands.set(name, command); },
		registerTool(value: any) { tool = value; },
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		sendMessage(message: any, options: any) { messages.push({ message, options }); },
	};
	const ctx = {
		mode: "tui",
		isIdle: () => idle,
		waitForIdle: mock(async () => { throw new Error("Connection setup must not wait for idle"); }),
		ui: {
			select: mock(async (): Promise<string | undefined> => "Normal commands only"),
			notify(message: string) { notices.push(message); },
			setStatus() {},
		},
	};
	sshSessionExtension(pi as any);
	return {
		ctx, messages, notices,
		setIdle(value: boolean) { idle = value; },
		connect: () => commands.get("ssh-connect")!.handler("dario@server", ctx),
		list: async () => (await tool.execute("test", { action: "list" }, undefined, undefined, ctx)).content[0].text as string,
		shutdown: () => handlers.get("session_shutdown")!({}, ctx),
	};
}

describe("SSH connection setup", () => {
	test("configures while busy and steers after setup", async () => {
		const h = harness();
		try {
			await h.connect();
			expect(h.ctx.ui.select).toHaveBeenCalledTimes(1);
			expect(h.ctx.waitForIdle).not.toHaveBeenCalled();
			expect(h.messages).toHaveLength(1);
			expect(h.messages[0].options).toEqual({ deliverAs: "steer" });
			expect(h.messages[0].message.content).toContain("The user authorized SSH access");
			expect(await h.list()).toContain("Target: dario@server:22");
		} finally { await h.shutdown(); }
	});

	test("keeps idle delivery passive", async () => {
		const h = harness(true);
		try {
			await h.connect();
			expect(h.messages[0].options).toEqual({ deliverAs: "nextTurn" });
		} finally { await h.shutdown(); }
	});

	test("uses agent state at completion and rejects duplicate setup", async () => {
		const h = harness(true);
		const choice = deferred<string | undefined>();
		h.ctx.ui.select.mockImplementation(() => choice.promise);
		const connecting = h.connect();
		try {
			expect(h.ctx.ui.select).toHaveBeenCalledTimes(1);
			expect(h.messages).toHaveLength(0);
			await h.connect();
			expect(h.ctx.ui.select).toHaveBeenCalledTimes(1);
			expect(h.notices).toContain("SSH connection setup is already in progress");
			h.setIdle(false);
			choice.resolve("Normal commands only");
			await connecting;
			expect(h.messages[0].options.deliverAs).toBe("steer");
		} finally { await h.shutdown(); }
	});

	test("does not steer if the agent finishes during setup", async () => {
		const h = harness();
		const choice = deferred<string | undefined>();
		h.ctx.ui.select.mockImplementation(() => choice.promise);
		const connecting = h.connect();
		try {
			h.setIdle(true);
			choice.resolve("Normal commands only");
			await connecting;
			expect(h.messages[0].options.deliverAs).toBe("nextTurn");
		} finally { await h.shutdown(); }
	});

	test("releases the setup guard after cancellation", async () => {
		const h = harness();
		h.ctx.ui.select.mockResolvedValueOnce(undefined);
		try {
			await h.connect();
			expect(h.messages).toHaveLength(0);
			await h.connect();
			expect(h.messages).toHaveLength(1);
		} finally { await h.shutdown(); }
	});

	test("hides the session until root authorization completes", async () => {
		const h = harness();
		const authorization = deferred<unknown>();
		const started = deferred<void>();
		startRoot = () => { started.resolve(); return authorization.promise; };
		h.ctx.ui.select.mockResolvedValue("Unrestricted root until disconnect");
		const connecting = h.connect();
		try {
			await started.promise;
			expect(await h.list()).toContain("No user-authorized SSH session");
			expect(h.messages).toHaveLength(0);
			authorization.resolve({ close: async () => {} });
			await connecting;
			expect(await h.list()).toContain("Root access: authorized until disconnect");
			expect(h.messages[0].options.deliverAs).toBe("steer");
		} finally { await h.shutdown(); }
	});

	test("closes a failed setup and allows another attempt", async () => {
		const h = harness();
		startRoot = async () => { throw new Error("Sudo authorization was cancelled or failed"); };
		h.ctx.ui.select.mockResolvedValueOnce("Unrestricted root until disconnect");
		try {
			await h.connect();
			expect(h.messages).toHaveLength(0);
			expect(h.notices).toContain("Sudo authorization was cancelled or failed");
			expect(clients.at(-1)?.ended).toBe(true);
			expect(await h.list()).toContain("No user-authorized SSH session");
			await h.connect();
			expect(h.messages).toHaveLength(1);
		} finally { await h.shutdown(); }
	});
});
