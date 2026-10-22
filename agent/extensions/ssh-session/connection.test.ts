import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

// No network connection or local OpenSSH process runs in these tests.
mock.module("node:child_process", () => ({
	spawnSync(command: string, args: string[]) {
		if (command !== "ssh") return { status: 1, stdout: "", stderr: "" };
		const [user, requestedHost] = args[1].includes("@") ? args[1].split("@") : ["dario", args[1]];
		const host = requestedHost === "server-alias" ? "server" : requestedHost;
		const port = host === "alternate-port" ? 2222 : 22;
		return { status: 0, stdout: `user ${user}\nhostname ${host}\nport ${port}\n`, stderr: "" };
	},
}));

const clients: FakeClient[] = [];
class FakeClient extends EventEmitter {
	ended = false;
	host = "";
	commands: string[] = [];
	sftpCalls = 0;
	channels = new Set<FakeChannel>();
	constructor() {
		super();
		clients.push(this);
	}
	connect(options: { host: string }) {
		this.host = options.host;
		queueMicrotask(() => this.emit(this.host === "closed-before-ready" ? "close" : "ready"));
	}
	end() {
		this.ended = true;
		for (const channel of this.channels) channel.close();
		queueMicrotask(() => this.emit("close"));
	}
	sftp(callback: (error: Error) => void) {
		this.sftpCalls++;
		callback(new Error(`SFTP test on ${this.host}`));
	}
	exec(command: string, callback: (error: null, channel: FakeChannel) => void) {
		this.commands.push(command);
		const channel = new FakeChannel();
		this.channels.add(channel);
		channel.once("close", () => this.channels.delete(channel));
		callback(null, channel);
		queueMicrotask(() => {
			if (command.includes("hold")) return;
			channel.emit("data", Buffer.from(command.includes("pwd") ? "/home/dario\n" : `${this.host}\n`));
			channel.emit("exit", 0);
			channel.close();
		});
	}
}
class FakeChannel extends EventEmitter {
	stderr = new EventEmitter();
	close() { this.emit("close"); }
	signal() {}
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
	const statuses: Array<string | undefined> = [];
	let tool: any;
	const pi = {
		registerCommand(name: string, command: { handler: Handler }) { commands.set(name, command); },
		registerTool(value: any) { tool = value; },
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		sendMessage(message: any, options: any) { messages.push({ message, options }); },
	};
	const ctx = {
		mode: "tui",
		cwd: import.meta.dir,
		isIdle: () => idle,
		waitForIdle: mock(async () => { throw new Error("Connection setup must not wait for idle"); }),
		ui: {
			select: mock(async (): Promise<string | undefined> => "Normal commands only"),
			notify(message: string) { notices.push(message); },
			setStatus(_key: string, value?: string) { statuses.push(value); },
		},
	};
	sshSessionExtension(pi as any);
	return {
		ctx, messages, notices, statuses,
		setIdle(value: boolean) { idle = value; },
		connect: (target = "dario@server") => commands.get("ssh-connect")!.handler(target, ctx),
		command: (name: string, args = "") => commands.get(name)!.handler(args, ctx),
		call: (params: Record<string, unknown>, onUpdate?: (result: any) => void) => tool.execute("test", params, undefined, onUpdate, ctx),
		list: async (id?: string) => (await tool.execute("test", { action: "list", session_id: id }, undefined, undefined, ctx)).content[0].text as string,
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

describe("multiple SSH connections", () => {
	test("shows one username in the footer and skips sudo choices for root logins", async () => {
		const h = harness();
		try {
			await h.connect("root@hero-1");
			expect(h.statuses.at(-1)).toBe("SSH: ssh-1 root@hero-1");
			expect(h.ctx.ui.select).not.toHaveBeenCalled();
			expect(h.messages[0].message.content).toContain('session_id: "ssh-1"');
			const result = await h.call({ action: "exec", command: "hostname" });
			expect(result.details.privileged).toBe(true);
			expect(result.content[0].text).toContain("Exit code: 0 (root)");
		} finally { await h.shutdown(); }
	});

	test("releases the setup guard when the connection closes before authentication", async () => {
		const h = harness();
		try {
			await h.connect("dario@closed-before-ready");
			expect(h.notices.at(-1)).toContain("closed before authentication completed");
			expect(h.messages).toHaveLength(0);
			await h.connect();
			expect(h.messages).toHaveLength(1);
		} finally { await h.shutdown(); }
	});

	test("adds connections and routes parallel commands to explicit IDs", async () => {
		const h = harness();
		try {
			await h.connect("dario@server");
			await h.connect("root@hero-1");
			expect(h.statuses.at(-1)).toBe("SSH: ssh-1 dario@server, ssh-2 root@hero-1");
			const listed = await h.call({ action: "list" });
			expect(listed.details.sessions.map((session: any) => [session.sessionId, session.rootAccess])).toEqual([
				["ssh-1", "none"], ["ssh-2", "login"],
			]);
			const results = await Promise.all(["ssh-1", "ssh-2"].map((session_id) => h.call({ action: "exec", session_id, command: "hostname" })));
			expect(results[0].details.sessionId).toBe("ssh-1");
			expect(results[0].content[0].text).toContain("\nserver\n");
			expect(results[1].details.sessionId).toBe("ssh-2");
			expect(results[1].content[0].text).toContain("\nhero-1\n");
			const selected = await h.call({ action: "list", session_id: "ssh-1" });
			expect(selected.details.sessions).toHaveLength(1);
			expect(selected.content[0].text).not.toContain("hero-1");
		} finally { await h.shutdown(); }
	});

	test("rejects ambiguous operations and unknown IDs without running commands", async () => {
		const h = harness();
		try {
			await h.connect();
			const first = clients.at(-1)!;
			await h.connect("dario@second");
			const second = clients.at(-1)!;
			const counts = [first.commands.length, second.commands.length];
			for (const action of ["exec", "sudo_exec", "upload", "download", "bg_start", "bg_status", "bg_wait", "bg_kill", "close"]) {
				await expect(h.call({ action })).rejects.toThrow("Set session_id explicitly");
				await expect(h.call({ action, session_id: "ssh-999" })).rejects.toThrow("Unknown SSH session");
			}
			await expect(h.call({ action: "list", session_id: "ssh-999" })).rejects.toThrow("Unknown SSH session");
			expect([first.commands.length, second.commands.length]).toEqual(counts);
			expect(first.ended || second.ended).toBe(false);
		} finally { await h.shutdown(); }
	});

	test("rejects duplicate resolved endpoints, including aliases", async () => {
		const h = harness();
		try {
			await h.connect();
			const count = clients.length;
			await h.connect("dario@server-alias");
			expect(clients).toHaveLength(count);
			expect(h.messages).toHaveLength(1);
			expect(h.notices.at(-1)).toContain("Already connected as ssh-1 to dario@server");
			await h.connect("root@server");
			expect((await h.call({ action: "list" })).details.sessions).toHaveLength(2);
		} finally { await h.shutdown(); }
	});

	test("shows resolved usernames for aliases and non-default ports", async () => {
		const h = harness();
		try {
			await h.connect("server-alias");
			expect(h.statuses.at(-1)).toBe("SSH: ssh-1 dario@server-alias");
			expect(await h.list()).toContain("Target: dario@server:22");
			await h.connect("root@alternate-port");
			expect(h.statuses.at(-1)).toContain("ssh-2 root@alternate-port:2222");
		} finally { await h.shutdown(); }
	});

	test("keeps existing connections when another setup fails", async () => {
		const h = harness();
		try {
			await h.connect();
			const first = clients.at(-1)!;
			startRoot = async () => { throw new Error("Sudo denied"); };
			h.ctx.ui.select.mockResolvedValueOnce("Unrestricted root until disconnect");
			await h.connect("dario@second");
			expect(first.ended).toBe(false);
			expect(clients.at(-1)?.ended).toBe(true);
			expect((await h.call({ action: "list" })).details.sessions.map((session: any) => session.sessionId)).toEqual(["ssh-1"]);
			expect(h.statuses.at(-1)).toBe("SSH: ssh-1 dario@server");
		} finally { await h.shutdown(); }
	});

	test("keeps root authorization separate for each connection", async () => {
		const h = harness();
		const execute = mock(async () => ({ exitCode: 0 }));
		const close = mock(async () => {});
		startRoot = async () => ({ execute, close });
		try {
			h.ctx.ui.select.mockResolvedValueOnce("Unrestricted root until disconnect");
			await h.connect();
			await h.connect("dario@second");
			await expect(h.call({ action: "sudo_exec", session_id: "ssh-2", command: "id" })).rejects.toThrow("did not grant root access");
			expect(execute).not.toHaveBeenCalled();
			const result = await h.call({ action: "sudo_exec", session_id: "ssh-1", command: "id" });
			expect(result.details.sessionId).toBe("ssh-1");
			expect(execute).toHaveBeenCalledTimes(1);
			await h.call({ action: "close", session_id: "ssh-2" });
			expect(close).not.toHaveBeenCalled();
			expect(await h.list()).toContain("Root access: authorized until disconnect");
		} finally { await h.shutdown(); }
		expect(close).toHaveBeenCalledTimes(1);
	});

	test("routes SFTP operations to the selected connection", async () => {
		const h = harness();
		try {
			await h.connect();
			const first = clients.at(-1)!;
			await h.connect("dario@second");
			const second = clients.at(-1)!;
			for (const action of ["upload", "download"]) {
				await expect(h.call({ action, session_id: "ssh-2", local_path: "connection.test.ts", remote_path: "/tmp/test" })).rejects.toThrow("SFTP test on second");
			}
			expect(first.sftpCalls).toBe(0);
			expect(second.sftpCalls).toBe(2);
		} finally { await h.shutdown(); }
	});

	test("keeps background jobs separate, even when job IDs match", async () => {
		const h = harness();
		try {
			await h.connect();
			await h.connect("dario@second");
			for (const session_id of ["ssh-1", "ssh-2"]) {
				const result = await h.call({ action: "bg_start", session_id, command: "hold", title: session_id });
				expect(result.details).toMatchObject({ sessionId: session_id, jobId: "bg-1" });
			}
			const first = await h.call({ action: "bg_status", session_id: "ssh-1", job_ids: ["bg-1"] });
			expect(first.content[0].text).toContain("bg-1 [running] ssh-1");
			expect(first.content[0].text).not.toContain("ssh-2");
			await h.call({ action: "bg_kill", session_id: "ssh-1", job_ids: ["bg-1"] });
			const second = await h.call({ action: "bg_status", session_id: "ssh-2", job_ids: ["bg-1"] });
			expect(second.content[0].text).toContain("bg-1 [running] ssh-2");
			await h.call({ action: "close", session_id: "ssh-1" });
			expect((await h.call({ action: "bg_status", job_ids: ["bg-1"] })).content[0].text).toContain("bg-1 [running] ssh-2");
		} finally { await h.shutdown(); }
	});

	test("keeps connection IDs invalid after close and reconnect", async () => {
		const h = harness();
		try {
			await h.connect();
			await h.connect("dario@second");
			await h.call({ action: "close", session_id: "ssh-1" });
			await h.connect();
			await expect(h.call({ action: "exec", session_id: "ssh-1", command: "hostname" })).rejects.toThrow("Unknown SSH session");
			expect((await h.call({ action: "list" })).details.sessions.map((session: any) => session.sessionId)).toEqual(["ssh-2", "ssh-3"]);
		} finally { await h.shutdown(); }
	});

	test("disconnects only the selected connection and steers a busy agent", async () => {
		const h = harness();
		try {
			await h.connect();
			const first = clients.at(-1)!;
			await h.connect("root@hero-1");
			const second = clients.at(-1)!;
			await h.command("ssh-disconnect", "ssh-1");
			expect(first.ended).toBe(true);
			expect(second.ended).toBe(false);
			expect(h.ctx.waitForIdle).not.toHaveBeenCalled();
			expect(h.messages.at(-1)?.options.deliverAs).toBe("steer");
			expect(h.messages.at(-1)?.message.content).toContain("closed SSH session ssh-1");
			expect(h.statuses.at(-1)).toBe("SSH: ssh-2 root@hero-1");
			await h.command("ssh-disconnect", "ssh-1");
			expect(second.ended).toBe(false);
			expect(h.notices.at(-1)).toContain("Unknown SSH session");
		} finally { await h.shutdown(); }
	});

	test("asks which connection to close and respects cancellation", async () => {
		const h = harness();
		try {
			await h.connect();
			await h.connect("dario@second");
			h.ctx.ui.select.mockResolvedValueOnce(undefined);
			await h.command("ssh-disconnect");
			expect((await h.call({ action: "list" })).details.sessions).toHaveLength(2);
			h.ctx.ui.select.mockResolvedValueOnce("ssh-2 dario@second");
			await h.command("ssh-disconnect");
			expect(await h.list()).toContain("Session: ssh-1");
			expect(await h.list()).not.toContain("ssh-2");
		} finally { await h.shutdown(); }
	});

	test("reports all connections or one selected connection in the status command", async () => {
		const h = harness();
		try {
			await h.connect();
			await h.connect("dario@second");
			await h.command("ssh-status");
			expect(h.notices.at(-1)).toContain("ssh-1");
			expect(h.notices.at(-1)).toContain("ssh-2");
			await h.command("ssh-status", "ssh-2");
			expect(h.notices.at(-1)).not.toContain("ssh-1");
			expect(h.notices.at(-1)).toContain("ssh-2");
		} finally { await h.shutdown(); }
	});

	test("removes only a lost connection and identifies it in the steering message", async () => {
		const h = harness();
		try {
			await h.connect();
			const first = clients.at(-1)!;
			await h.connect("dario@second");
			first.end();
			await Promise.resolve();
			expect(h.statuses.at(-1)).toBe("SSH: ssh-2 dario@second");
			expect(h.messages.at(-1)?.message.content).toContain("SSH session ssh-1 to dario@server was lost");
			expect(h.messages.at(-1)?.options.deliverAs).toBe("steer");
			expect((await h.call({ action: "exec", command: "hostname" })).content[0].text).toContain("\nsecond\n");
		} finally { await h.shutdown(); }
	});

	test("includes the connection in progress messages", async () => {
		const h = harness();
		try {
			await h.connect();
			const updates: any[] = [];
			await h.call({ action: "exec", session_id: "ssh-1", command: "hostname" }, (result) => updates.push(result));
			expect(updates[0].details.sessionId).toBe("ssh-1");
			expect(updates[0].content[0].text).toStartWith("Session: ssh-1 (dario@server)");
		} finally { await h.shutdown(); }
	});

	test("closes every connection on shutdown", async () => {
		const h = harness();
		await h.connect();
		const first = clients.at(-1)!;
		await h.connect("dario@second");
		const second = clients.at(-1)!;
		await h.shutdown();
		expect(first.ended && second.ended).toBe(true);
		expect(await h.list()).toContain("No user-authorized SSH session");
		expect(h.statuses.at(-1)).toBeUndefined();
	});

	test("does not publish a connection after shutdown during authorization", async () => {
		const h = harness();
		const authorization = deferred<unknown>();
		const started = deferred<void>();
		startRoot = () => { started.resolve(); return authorization.promise; };
		h.ctx.ui.select.mockResolvedValueOnce("Unrestricted root until disconnect");
		const connecting = h.connect();
		await started.promise;
		await h.shutdown();
		expect(clients.at(-1)?.ended).toBe(true);
		authorization.resolve({ close: async () => {} });
		await connecting;
		expect(h.messages).toHaveLength(0);
		expect(clients.at(-1)?.ended).toBe(true);
		expect(await h.list()).toContain("No user-authorized SSH session");
	});

	test("does not publish a connection lost during root authorization", async () => {
		const h = harness();
		const authorization = deferred<unknown>();
		const started = deferred<void>();
		startRoot = () => { started.resolve(); return authorization.promise; };
		h.ctx.ui.select.mockResolvedValueOnce("Unrestricted root until disconnect");
		const connecting = h.connect();
		try {
			await started.promise;
			clients.at(-1)!.end();
			await Promise.resolve();
			authorization.resolve({ close: async () => {} });
			await connecting;
			expect(h.messages).toHaveLength(0);
			expect(h.notices.at(-1)).toContain("SSH connection closed during setup");
			expect(await h.list()).toContain("No user-authorized SSH session");
		} finally { await h.shutdown(); }
	});

	test("closes transports even when one root channel fails during cleanup", async () => {
		const h = harness();
		startRoot = async () => ({ close: async () => { throw new Error("Channel already closed"); } });
		h.ctx.ui.select.mockResolvedValueOnce("Unrestricted root until disconnect");
		await h.connect();
		const first = clients.at(-1)!;
		await h.connect("dario@second");
		const second = clients.at(-1)!;
		await h.shutdown();
		expect(first.ended && second.ended).toBe(true);
	});
});
