import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	BashOperations,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Client, ParsedKey } from "ssh2";
import { BackgroundProcessManager, type BackgroundProcessSnapshot } from "../background-processes/manager.ts";
import { TailBuffer } from "../background-processes/tail-buffer.ts";
import {
	CommandOutputCapture,
	formatCapturedOutput,
	formatTailPreview,
	type CapturedOutput,
} from "./output-capture.ts";
import {
	downloadFile,
	resolveLocalTransferPath,
	resolveRemoteTransferPath,
	type TransferResult,
	uploadFile,
} from "./file-transfer.ts";
import { buildRemoteCommand, parseSshConfig, type ResolvedSshTarget } from "./protocol.ts";
import { RootShell } from "./root-shell.ts";
import { renderSshCall, renderSshResult } from "./ui.ts";

const SSH_PATH = "ssh";

const ToolParameters = Type.Object({
	action: StringEnum(
		["exec", "sudo_exec", "upload", "download", "bg_start", "bg_status", "bg_wait", "bg_kill", "list", "close"] as const,
		{ description: "SSH session operation" },
	),
	session_id: Type.Optional(Type.String({ minLength: 1, description: "Connection ID from list, such as ssh-1. Required when multiple connections exist; list without it shows all connections." })),
	command: Type.Optional(Type.String({ description: "Non-interactive remote shell command for exec, sudo_exec, or bg_start" })),
	cwd: Type.Optional(Type.String({ description: "Absolute remote working directory; defaults to the connected session directory" })),
	local_path: Type.Optional(Type.String({ description: "Local file path for upload or download; relative paths use Pi's current working directory" })),
	remote_path: Type.Optional(Type.String({ description: "Remote file path for upload or download; relative paths use cwd" })),
	overwrite: Type.Optional(Type.Boolean({ description: "Allow an existing destination file to be atomically replaced; defaults to false" })),
	mode: Type.Optional(Type.Integer({ minimum: 0, maximum: 0o777, description: "Optional remote permission mode for upload, as an integer (for example 493 for 0755)" })),
	title: Type.Optional(Type.String({ description: "Short title for bg_start" })),
	job_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32 })),
	timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
});

interface ActiveSession {
	readonly id: string;
	readonly target: ResolvedSshTarget;
	readonly client: Client;
	readonly remoteCwd: string;
	manager: BackgroundProcessManager;
	backgroundOutputs: BackgroundOutputRegistry;
	rootShell?: RootShell;
	closing: boolean;
}

export default function sshSessionExtension(pi: ExtensionAPI) {
	const sessions = new Map<string, ActiveSession>();
	let nextSessionId = 1;
	let connecting = false;
	let setupClient: Client | undefined;
	let shuttingDown = false;
	let latestContext: ExtensionContext | undefined;

	const setStatus = (ctx: ExtensionContext) => {
		latestContext = ctx;
		ctx.ui.setStatus(
			"ssh-session",
			sessions.size
				? `SSH: ${[...sessions.values()].map((session) => `${session.id} ${formatTargetLabel(session.target)}${session.rootShell ? " • root" : ""}`).join(", ")}`
				: undefined,
		);
	};

	const announce = (content: string, deliverAs: "steer" | "nextTurn" = "nextTurn") => {
		pi.sendMessage(
			{ customType: "ssh-session-state", content, display: true },
			{ deliverAs },
		);
	};
	const connectionState = () => sessions.size
		? `Available SSH sessions: ${[...sessions.keys()].join(", ")}.`
		: "No SSH sessions remain connected.";

	const connect = async (rawTarget: string, ctx: ExtensionCommandContext) => {
		if (shuttingDown) throw new Error("The SSH extension is shutting down");
		if (ctx.mode !== "tui") {
			throw new Error("/ssh-connect currently requires Pi's TUI for masked password and sudo prompts");
		}

		const requested = validateTarget(rawTarget);
		const target = resolveTarget(requested);
		const existing = [...sessions.values()].find((session) =>
			session.target.user === target.user && session.target.hostName === target.hostName && session.target.port === target.port,
		);
		if (existing) throw new Error(`Already connected as ${existing.id} to ${formatTargetLabel(existing.target)}; disconnect that session first`);
		const knownFingerprints = getKnownFingerprints(target);

		// A root login already runs every exec as root, so sudo adds nothing.
		const loginIsRoot = target.user === "root";
		const privilege = loginIsRoot
			? "Normal commands only"
			: await ctx.ui.select(`Agent privilege for ${formatTargetLabel(target)}`, [
					"Normal commands only",
					"Unrestricted root until disconnect",
				]);
		if (!privilege) return;
		if (shuttingDown) throw new Error("The SSH extension is shutting down");

		const client = await connectClient(ctx, target, knownFingerprints, (client) => {
			if (shuttingDown) {
				client.end();
				throw new Error("The SSH extension is shutting down");
			}
			setupClient = client;
		});
		let connectionClosed = false;
		client.once("close", () => { connectionClosed = true; });
		let active: ActiveSession | undefined;
		try {
			const operations = createRemoteOperations(client);
			const pwd = await captureExec(operations, "pwd", ".", 15_000);
			if (pwd.exitCode !== 0) throw new Error(`Could not determine remote working directory: ${pwd.output.text.trim()}`);
			const remoteCwd = pwd.output.text.trim().split(/\r?\n/u).at(-1);
			if (!remoteCwd?.startsWith("/")) throw new Error(`Remote pwd returned an invalid directory: ${remoteCwd ?? ""}`);

			// Keep the session private until all requested authorization is complete.
			const rootShell = privilege === "Unrestricted root until disconnect"
				? await RootShell.start(ctx, client)
				: undefined;
			if (shuttingDown) throw new Error("The SSH extension shut down during connection setup");
			if (connectionClosed) throw new Error("The SSH connection closed during setup");
			const backgroundOutputs = new BackgroundOutputRegistry(operations);
			const manager = new BackgroundProcessManager(backgroundOutputs.operations, {
				maxRunning: 8,
				maxEntries: 32,
				maxOutputBytes: 1024 * 1024,
				persistFullOutput: false,
			});
			manager.subscribe((event) => {
				if (event.kind === "pruned") backgroundOutputs.forget(event.id);
			});
			active = {
				id: `ssh-${nextSessionId++}`,
				target,
				client,
				remoteCwd,
				manager,
				backgroundOutputs,
				rootShell,
				closing: false,
			};
			const session = active;
			sessions.set(session.id, session);

			client.on("close", () => {
				if (sessions.get(session.id) !== session || session.closing) return;
				sessions.delete(session.id);
				session.closing = true;
				void Promise.allSettled([session.manager.dispose(1000), session.rootShell?.close()]);
				if (latestContext) {
					setStatus(latestContext);
					latestContext.ui.notify(`SSH session ${session.id} to ${formatTargetLabel(target)} closed`, "warning");
					announce(`SSH session ${session.id} to ${formatTargetLabel(target)} was lost. ${connectionState()}`, latestContext.isIdle() ? "nextTurn" : "steer");
				}
			});

			setStatus(ctx);
			announce(
				`The user authorized SSH access to ${target.user}@${target.hostName}:${target.port} (${remoteCwd}). ` +
				`Use session_id: "${session.id}" for this connection (${formatTargetLabel(target)}). ${connectionState()} ` +
				(loginIsRoot
					? "The session is logged in as root, so exec runs commands as root; sudo_exec is not needed."
					: session.rootShell
						? "The ssh_session tool may run normal and unrestricted root commands until disconnect."
						: "The ssh_session tool may run normal commands; root access was not authorized."),
				ctx.isIdle() ? "nextTurn" : "steer",
			);
			ctx.ui.notify(`Connected ${session.id} to ${formatTargetLabel(target)}${session.rootShell ? " with session root access" : ""}`, "info");
		} catch (error) {
			if (active) {
				sessions.delete(active.id);
				await closeSession(active);
				setStatus(ctx);
			} else client.end();
			throw error;
		}
	};

	pi.registerCommand("ssh-connect", {
		description: "Open a user-authorized persistent SSH session: /ssh-connect user@host",
		handler: async (args, ctx) => {
			if (connecting) {
				ctx.ui.notify("SSH connection setup is already in progress", "warning");
				return;
			}
			connecting = true;
			try {
				await connect(args, ctx);
			} catch (error) {
				if (!shuttingDown) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			} finally {
				setupClient = undefined;
				connecting = false;
			}
		},
	});

	pi.registerCommand("ssh-disconnect", {
		description: "Close an SSH connection: /ssh-disconnect [session_id]",
		handler: async (args, ctx) => {
			if (!sessions.size) {
				ctx.ui.notify("No SSH session is connected", "info");
				return;
			}
			try {
				let id = args.trim();
				if (!id && sessions.size > 1) {
					const choice = await ctx.ui.select("Disconnect which SSH session?", [...sessions.values()].map((session) => `${session.id} ${formatTargetLabel(session.target)}`));
					if (!choice) return;
					id = choice.split(" ")[0];
				}
				const active = requireSession(sessions, id || undefined);
				sessions.delete(active.id);
				setStatus(ctx);
				announce(`The user closed SSH session ${active.id} to ${formatTargetLabel(active.target)}. Do not use this session. ${connectionState()}`, ctx.isIdle() ? "nextTurn" : "steer");
				await closeSession(active);
				ctx.ui.notify(`Disconnected ${active.id} from ${formatTargetLabel(active.target)}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("ssh-status", {
		description: "Show SSH connections and their background jobs: /ssh-status [session_id]",
		handler: async (args, ctx) => {
			try {
				ctx.ui.notify(formatSessions(sessions, args.trim() || undefined), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "ssh_session",
		label: "SSH session",
		description:
			"Operate on user-authorized persistent SSH connections. Only the user can connect, with /ssh-connect for each server. Use list to get connection IDs, targets, root permissions, and background jobs. Unfiltered list shows all connections. Set session_id for other operations when multiple connections exist; omit it only when exactly one exists. Each connection has separate root authorization and background jobs. Job IDs belong to their connection. exec and sudo_exec run foreground commands. upload and download atomically transfer individual regular files over the selected authenticated SFTP channel. bg_start, bg_status, bg_wait, and bg_kill manage background jobs as the login user, without the sudo channel. close disconnects only the selected connection. sudo_exec requires root authorization for that connection; root logins use exec. Output is limited to 2000 lines or 50KB. Complete output is saved to a local temp file when truncated.",
		parameters: ToolParameters,
		renderCall(args, theme, context) {
			return renderSshCall(args, theme, context.expanded, context.lastComponent as Text | undefined, context.cwd);
		},
		renderResult(result, options, theme, context) {
			return renderSshResult(
				result,
				options,
				theme,
				context.lastComponent as Text | undefined,
				context.isError,
				context.cwd,
			);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			latestContext = ctx;
			if (params.action === "list") {
				const selected = params.session_id ? [requireSession(sessions, params.session_id)] : [...sessions.values()];
				return textResult(formatSessions(sessions, params.session_id), { action: "list", sessions: selected.map(sessionDetails) });
			}
			const active = requireSession(sessions, params.session_id);
			if (active.closing) throw new Error("The SSH session is closing");
			const cwd = validateRemoteCwd(params.cwd ?? active.remoteCwd);
			const resultForSession = (result: ReturnType<typeof textResult>) => ({
				...result,
				content: [{ type: "text" as const, text: `Session: ${active.id} (${formatTargetLabel(active.target)})\n${result.content[0].text}` }],
				details: { ...result.details, sessionId: active.id, target: formatTargetLabel(active.target) },
			});
			const updateForSession = (text: string, details: Record<string, unknown>) =>
				onUpdate?.(resultForSession(textResult(text, details)));

			switch (params.action) {
				case "exec": {
					const command = requireCommand(params.command);
					const result = await runCapturedCommand(
						createRemoteOperations(active.client),
						command,
						cwd,
						params.timeout_seconds,
						signal,
						(text) => updateForSession(text, { running: true }),
						"exec",
					);
					return resultForSession(commandResult("exec", result.exitCode, result.output, active.target.user === "root"));
				}
				case "sudo_exec": {
					const command = requireCommand(params.command);
					if (!active.rootShell) {
						if (active.target.user === "root") throw new Error("This SSH session is logged in as root; use exec");
						throw new Error("The user did not grant root access for this SSH session; reconnect and select unrestricted root access");
					}
					const capture = new CommandOutputCapture("sudo-exec");
					try {
						const result = await active.rootShell.execute(command, cwd, {
							signal,
							timeoutMs: params.timeout_seconds === undefined ? undefined : params.timeout_seconds * 1000,
							onData: (chunk) => capture.append(chunk),
						});
						return resultForSession(commandResult("sudo_exec", result.exitCode, capture.finish(), true));
					} catch (error) {
						throw enrichCaptureError(error, capture.finish());
					}
				}
				case "upload": {
					const localPath = resolveLocalTransferPath(requirePath(params.local_path, "local_path"), ctx.cwd);
					const remotePath = resolveRemoteTransferPath(requirePath(params.remote_path, "remote_path"), cwd);
					const result = await uploadFile({
						client: active.client,
						localPath,
						remotePath,
						overwrite: params.overwrite ?? false,
						mode: params.mode,
						signal,
						timeoutMs: params.timeout_seconds === undefined ? undefined : params.timeout_seconds * 1000,
						onProgress: (text, transferredBytes, totalBytes) =>
							updateForSession(text, { running: true, transferredBytes, totalBytes }),
					});
					return resultForSession(transferResult("upload", result));
				}
				case "download": {
					const localPath = resolveLocalTransferPath(requirePath(params.local_path, "local_path"), ctx.cwd);
					const remotePath = resolveRemoteTransferPath(requirePath(params.remote_path, "remote_path"), cwd);
					const result = await downloadFile({
						client: active.client,
						localPath,
						remotePath,
						overwrite: params.overwrite ?? false,
						signal,
						timeoutMs: params.timeout_seconds === undefined ? undefined : params.timeout_seconds * 1000,
						onProgress: (text, transferredBytes, totalBytes) =>
							updateForSession(text, { running: true, transferredBytes, totalBytes }),
					});
					return resultForSession(transferResult("download", result));
				}
				case "bg_start": {
					if (signal?.aborted) throw new Error("Background start aborted before launch");
					const command = requireCommand(params.command);
					const title = (params.title?.trim() || command).slice(0, 80);
					const started = active.manager.start(command, title, cwd);
					active.backgroundOutputs.claim(started.id);
					return resultForSession(textResult(`Started ${started.id}: ${title}\nHost: ${active.target.user}@${active.target.hostName}\nCWD: ${cwd}`, {
						action: "bg_start",
						jobId: started.id,
					}));
				}
				case "bg_status": {
					const ids = requireJobIds(params.job_ids);
					const outputs = ids.map((id) => active.backgroundOutputs.get(id));
					const outputPaths = ids.map((id) => active.backgroundOutputs.getPath(id));
					return resultForSession(textResult(
						ids.map((id, index) => formatJob(active.manager.get(id, true), true, outputs[index], outputPaths[index])).join("\n\n"),
						{
							action: "bg_status",
							jobIds: ids,
							fullOutputPaths: outputPaths.filter((path): path is string => Boolean(path)),
						},
					));
				}
				case "bg_wait": {
					const ids = requireJobIds(params.job_ids);
					const waited = await active.manager.wait(ids, {
						timeoutMs: params.timeout_seconds === undefined ? undefined : params.timeout_seconds * 1000,
						signal,
						onUpdate: (runningIds) =>
							updateForSession(`Still running: ${runningIds.join(", ")}`, { runningIds }),
					});
					const settled = waited.settled
						.map((item) => formatJob(item, true, active.backgroundOutputs.get(item.id), active.backgroundOutputs.getPath(item.id)))
						.join("\n\n");
					const fullOutputPaths = waited.settled.flatMap((item) => {
						const path = active.backgroundOutputs.get(item.id)?.fullOutputPath;
						return path ? [path] : [];
					});
					return resultForSession(textResult(
						[settled || "No selected jobs settled.", waited.runningIds.length ? `Still running: ${waited.runningIds.join(", ")}` : ""].filter(Boolean).join("\n\n"),
						{ action: "bg_wait", jobIds: ids, runningIds: waited.runningIds, fullOutputPaths },
					));
				}
				case "bg_kill": {
					const ids = requireJobIds(params.job_ids);
					const killed = await active.manager.kill(ids);
					return resultForSession(textResult(killed.map((item) => `${item.id}: ${item.outcome}`).join("\n"), {
						action: "bg_kill",
						jobIds: ids,
					}));
				}
				case "close": {
					sessions.delete(active.id);
					setStatus(ctx);
					await closeSession(active);
					return resultForSession(textResult(`Closed SSH session to ${formatTargetLabel(active.target)}.`, { action: "close" }));
				}
			}
		},
	});

	pi.on("session_start", (_event, ctx) => setStatus(ctx));

	pi.on("session_shutdown", async (_event, ctx) => {
		shuttingDown = true;
		setupClient?.end();
		setupClient = undefined;
		latestContext = ctx;
		const active = [...sessions.values()];
		sessions.clear();
		await Promise.allSettled(active.map(closeSession));
		ctx.ui.setStatus("ssh-session", undefined);
	});
}

async function connectClient(
	ctx: ExtensionCommandContext,
	target: ResolvedSshTarget,
	knownFingerprints: string[],
	onClient: (client: Client) => void,
): Promise<Client> {
	const { Client, utils } = await import("ssh2");
	const client = new Client();
	onClient(client);
	let authenticationCancelled = false;
	let passwordAttempted = false;
	let nextKeyIndex = 0;
	const privateKeys: Array<
		| { readonly path: string; readonly parsed: ParsedKey }
		| { readonly path: string; readonly encrypted: string }
	> = [];
	for (const identityFile of target.identityFiles ?? []) {
		try {
			const path = expandTilde(identityFile);
			const key = readFileSync(path, "utf8");
			const parsed = utils.parseKey(key);
			if (!(parsed instanceof Error)) privateKeys.push({ path, parsed });
			else if (/no passphrase/iu.test(parsed.message)) privateKeys.push({ path, encrypted: key });
		} catch {
			// OpenSSH lists default identity paths even when the files do not exist.
		}
	}

	return new Promise<Client>((resolve, reject) => {
		let settled = false;
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			client.end();
			reject(error);
		};
		client.once("ready", () => {
			if (settled) return;
			settled = true;
			resolve(client);
		});
		client.on("error", (error) => {
			fail(authenticationCancelled ? new Error("SSH authentication cancelled") : error);
		});
		client.once("close", () => fail(new Error("SSH connection closed before authentication completed")));

		client.connect({
			host: target.hostName,
			port: target.port,
			username: target.user,
			readyTimeout: 30_000,
			keepaliveInterval: 30_000,
			keepaliveCountMax: 3,
			hostVerifier(key, verify) {
				const actual = fingerprintHostKey(key);
				if (knownFingerprints.length > 0) {
					if (knownFingerprints.includes(actual)) verify(true);
					else {
						verify(false);
						fail(
							new Error(
								`SSH HOST KEY MISMATCH for ${target.hostName}. Expected ${knownFingerprints.join(", ")}; received ${actual}.`,
							),
						);
					}
					return;
				}
				void ctx.ui
					.confirm(
						"Unknown SSH host key",
						`Host: ${target.hostName}:${target.port}\nFingerprint: ${actual}\n\nTrust this negotiated key for this session?`,
					)
					.then((approved) => verify(approved), () => verify(false));
			},
			authHandler(methodsLeft, _partialSuccess, callback) {
				void (async () => {
					if ((!methodsLeft || methodsLeft.includes("publickey")) && nextKeyIndex < privateKeys.length) {
						while (nextKeyIndex < privateKeys.length) {
							const candidate = privateKeys[nextKeyIndex++];
							if ("parsed" in candidate) {
								callback({ type: "publickey", username: target.user, key: candidate.parsed });
								return;
							}

							const passphrase = await promptSecret(
								ctx,
								`Passphrase for ${candidate.path}`,
								"Passphrase",
							);
							if (passphrase === undefined) continue;
							const parsed = utils.parseKey(candidate.encrypted, passphrase);
							if (parsed instanceof Error) {
								ctx.ui.notify(`Could not unlock SSH key ${candidate.path}`, "warning");
								continue;
							}
							callback({ type: "publickey", username: target.user, key: parsed });
							return;
						}
					}

					if (passwordAttempted || (methodsLeft && !methodsLeft.includes("password"))) {
						callback(false);
						return;
					}
					passwordAttempted = true;
					const password = await promptSecret(ctx, `Password for ${target.user}@${target.hostName}`);
					if (password === undefined) {
						authenticationCancelled = true;
						callback(false);
						return;
					}
					callback({ type: "password", username: target.user, password });
				})().catch(() => {
					authenticationCancelled = true;
					callback(false);
				});
			},
		});
	});
}

async function promptSecret(
	ctx: ExtensionCommandContext,
	title: string,
	label = "Password",
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		let characters: string[] = [];
		let finished = false;
		const finish = (value: string | undefined) => {
			if (finished) return;
			finished = true;
			characters.fill("");
			characters = [];
			done(value);
		};

		return {
			render(width: number) {
				return [
					truncateToWidth(theme.fg("accent", theme.bold(title)), width),
					truncateToWidth(`${label}: ${"•".repeat(characters.length)}`, width),
					truncateToWidth(theme.fg("dim", "Enter confirms • Esc cancels • value is never sent to the model"), width),
				];
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.enter)) {
					const value = characters.join("");
					finish(value);
					return;
				}
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
					finish(undefined);
					return;
				}
				if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
					characters.pop();
					tui.requestRender();
					return;
				}
				const bracketedPaste = data.includes("\x1b[200~") || data.includes("\x1b[201~");
				if (bracketedPaste) data = data.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "");
				else if (data.startsWith("\x1b")) return;
				for (const character of data) {
					const code = character.codePointAt(0) ?? 0;
					if (code >= 32 && code !== 127) characters.push(character);
				}
				tui.requestRender();
			},
		};
	});
}

function fingerprintHostKey(key: Buffer): string {
	return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/u, "")}`;
}

function validateTarget(value: string): string {
	const target = value.trim();
	if (!target || /\s/u.test(target) || target.startsWith("-")) {
		throw new Error("Usage: /ssh-connect user@host");
	}
	return target;
}

/** Expand a leading `~` or `~/` in a resolved path to the user's home directory. */
function expandTilde(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function resolveTarget(requested: string): ResolvedSshTarget {
	const result = spawnSync(SSH_PATH, ["-G", requested], { encoding: "utf8", windowsHide: true });
	if (result.status !== 0) throw new Error((result.stderr || "Could not resolve OpenSSH configuration").trim());
	return parseSshConfig(requested, result.stdout);
}

function getKnownFingerprints(target: ResolvedSshTarget): string[] {
	const requestedHost = target.requested.includes("@") ? target.requested.slice(target.requested.lastIndexOf("@") + 1) : target.requested;
	const hosts = new Set([requestedHost, target.hostName]);
	const fingerprints = new Set<string>();
	for (const candidate of hosts) {
		const host = target.port === 22 ? candidate : `[${candidate}]:${target.port}`;
		const found = spawnSync("ssh-keygen", ["-F", host], { encoding: "utf8", windowsHide: true });
		if (found.status !== 0 || !found.stdout.trim()) continue;
		for (const line of found.stdout.split(/\r?\n/u)) {
			if (!line || line.startsWith("#")) continue;
			const key = line.split(/\s+/u).slice(1).join(" ");
			if (!key) continue;
			const result = spawnSync("ssh-keygen", ["-lf", "-"], { input: `${key}\n`, encoding: "utf8", windowsHide: true });
			if (result.status === 0) {
				const match = result.stdout.match(/\b(SHA256:[A-Za-z0-9+/=]+)/u);
				if (match) fingerprints.add(match[1].replace(/=+$/u, ""));
			}
		}
	}
	return [...fingerprints];
}

function createRemoteOperations(client: Client): BashOperations {
	return {
		exec(command, cwd, { onData, signal, timeout }) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}
				client.exec(buildRemoteCommand(command, cwd), (openError, channel) => {
					if (openError) {
						reject(openError);
						return;
					}
					let settled = false;
					let exitCode: number | null = null;
					let timedOut = false;
					const finish = (error?: Error) => {
						if (settled) return;
						settled = true;
						if (timer) clearTimeout(timer);
						signal?.removeEventListener("abort", onAbort);
						if (error) reject(error);
						else resolve({ exitCode });
					};
					const onAbort = () => {
						try {
							channel.signal("INT");
						} catch {}
						channel.close();
						finish(new Error("aborted"));
					};
					const timer = timeout
						? setTimeout(() => {
								timedOut = true;
								try {
									channel.signal("TERM");
								} catch {}
								channel.close();
								finish(new Error(`timeout:${timeout}`));
							}, timeout * 1000)
						: undefined;
					const handleData = (chunk: Buffer) => {
						try {
							onData(chunk);
						} catch (error) {
							channel.close();
							finish(error instanceof Error ? error : new Error(String(error)));
						}
					};
					channel.on("data", handleData);
					channel.stderr.on("data", handleData);
					channel.on("exit", (code: number | null) => {
						exitCode = code;
					});
					channel.on("error", (error: Error) => finish(error));
					channel.on("close", () => {
						if (timedOut) finish(new Error(`timeout:${timeout}`));
						else if (signal?.aborted) finish(new Error("aborted"));
						else finish();
					});
					signal?.addEventListener("abort", onAbort, { once: true });
					if (signal?.aborted) onAbort();
				});
			});
		},
	};
}

async function captureExec(operations: BashOperations, command: string, cwd: string, timeoutMs: number) {
	const output = new TailBuffer(50 * 1024);
	const result = await operations.exec(command, cwd, {
		onData: (chunk) => output.append(chunk),
		timeout: Math.ceil(timeoutMs / 1000),
	});
	return { exitCode: result.exitCode ?? 255, output: output.snapshot() };
}

async function runCapturedCommand(
	operations: BashOperations,
	command: string,
	cwd: string,
	timeoutSeconds: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: (text: string) => void,
	label: string,
) {
	const capture = new CommandOutputCapture(label);
	let lastUpdate = 0;
	try {
		const result = await operations.exec(command, cwd, {
			signal,
			timeout: timeoutSeconds,
			onData: (chunk) => {
				capture.append(chunk);
				if (Date.now() - lastUpdate > 250) {
					lastUpdate = Date.now();
					onUpdate(capture.preview());
				}
			},
		});
		return { exitCode: result.exitCode ?? 255, output: capture.finish() };
	} catch (error) {
		throw enrichCaptureError(error, capture.finish());
	}
}

interface BackgroundCaptureRecord {
	readonly capture: CommandOutputCapture;
	output?: CapturedOutput;
}

class BackgroundOutputRegistry {
	private readonly unclaimed: BackgroundCaptureRecord[] = [];
	private readonly records = new Map<string, BackgroundCaptureRecord>();
	readonly operations: BashOperations;

	constructor(base: BashOperations) {
		this.operations = {
			exec: (command, cwd, options) => {
				const record: BackgroundCaptureRecord = { capture: new CommandOutputCapture("background") };
				this.unclaimed.push(record);
				let execution: ReturnType<BashOperations["exec"]>;
				try {
					execution = base.exec(command, cwd, {
						...options,
						onData: (chunk) => {
							record.capture.append(chunk);
							options.onData(chunk);
						},
					});
				} catch (error) {
					record.output = record.capture.finish();
					throw error;
				}
				return execution.then(
					(result) => {
						record.output = record.capture.finish();
						return result;
					},
					(error) => {
						record.output = record.capture.finish();
						throw error;
					},
				);
			},
		};
	}

	claim(id: string): void {
		const record = this.unclaimed.shift();
		if (record) this.records.set(id, record);
	}

	get(id: string): CapturedOutput | undefined {
		return this.records.get(id)?.output;
	}

	getPath(id: string): string | undefined {
		const record = this.records.get(id);
		return record?.output?.fullOutputPath ?? record?.capture.dumpPathIfLarge;
	}

	forget(id: string): void {
		this.records.delete(id);
	}
}

function validateRemoteCwd(cwd: string): string {
	const value = cwd.trim();
	if (!value.startsWith("/") || value.includes("\0")) throw new Error("cwd must be an absolute remote POSIX path");
	return value;
}

function requireCommand(command: string | undefined): string {
	const value = command?.trim();
	if (!value) throw new Error("This action requires a non-empty command");
	return value;
}

function requirePath(path: string | undefined, name: "local_path" | "remote_path"): string {
	if (path === undefined) throw new Error(`This action requires ${name}`);
	return path;
}

function requireJobIds(ids: string[] | undefined): string[] {
	if (!ids?.length) throw new Error("This action requires job_ids");
	return ids;
}

function requireSession(sessions: ReadonlyMap<string, ActiveSession>, id?: string): ActiveSession {
	if (id !== undefined) {
		const session = sessions.get(id);
		if (!session) throw new Error(`Unknown SSH session: ${id}. Use ssh_session list to see connected session IDs.`);
		return session;
	}
	if (!sessions.size) throw new Error("No user-authorized SSH session is connected. The user must run /ssh-connect user@host.");
	if (sessions.size > 1) {
		throw new Error(`Multiple SSH sessions are connected. Set session_id explicitly: ${[...sessions.keys()].join(", ")}.`);
	}
	return sessions.values().next().value!;
}

function commandResult(action: "exec" | "sudo_exec", exitCode: number, output: CapturedOutput, privileged: boolean) {
	return {
		content: [{ type: "text" as const, text: `${formatCapturedOutput(output)}\n\nExit code: ${exitCode}${privileged ? " (root)" : ""}` }],
		details: {
			action,
			exitCode,
			privileged,
			totalBytes: output.totalBytes,
			totalLines: output.totalLines,
			outputBytes: output.outputBytes,
			outputLines: output.outputLines,
			truncated: output.truncated,
			fullOutputPath: output.fullOutputPath,
		},
	};
}

function transferResult(action: "upload" | "download", result: TransferResult) {
	const verb = action === "upload" ? "Uploaded" : "Downloaded";
	return {
		content: [{
			type: "text" as const,
			text: [
				`${verb} ${formatTransferBytes(result.bytes)} in ${formatTransferDuration(result.elapsedMs)}`,
				`Local: ${result.localPath}`,
				`Remote: ${result.remotePath}`,
				`SHA-256: ${result.sha256}`,
				`Remote mode: ${result.remoteMode.toString(8).padStart(4, "0")}`,
			].join("\n"),
		}],
		details: { action, ...result },
	};
}

function formatTransferBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function formatTransferDuration(milliseconds: number): string {
	return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function formatTargetLabel(target: ResolvedSshTarget): string {
	const host = target.requested.slice(target.requested.lastIndexOf("@") + 1);
	return `${target.user}@${host}${target.port === 22 ? "" : `:${target.port}`}`;
}

function sessionDetails(session: ActiveSession) {
	return {
		sessionId: session.id,
		target: formatTargetLabel(session.target),
		hostName: session.target.hostName,
		user: session.target.user,
		port: session.target.port,
		cwd: session.remoteCwd,
		rootAccess: session.target.user === "root" ? "login" : session.rootShell ? "sudo" : "none",
		jobs: session.manager.list().map(({ id, title, status }) => ({ id, title, status })),
	};
}

function formatSessions(sessions: ReadonlyMap<string, ActiveSession>, id?: string): string {
	if (id !== undefined) return formatSession(requireSession(sessions, id), true);
	if (!sessions.size) return "No user-authorized SSH session is connected.";
	return [...sessions.values()].map((session) => formatSession(session, true)).join("\n\n");
}

function formatSession(session: ActiveSession, includeJobs: boolean): string {
	const lines = [
		`Session: ${session.id} (${formatTargetLabel(session.target)})`,
		`Target: ${session.target.user}@${session.target.hostName}:${session.target.port}`,
		`CWD: ${session.remoteCwd}`,
		`Root access: ${session.target.user === "root" ? "logged in as root" : session.rootShell ? "authorized until disconnect" : "not authorized"}`,
	];
	if (includeJobs) {
		const jobs = session.manager.list();
		lines.push(jobs.length ? `Jobs:\n${jobs.map((job) => formatJob(job, false, session.backgroundOutputs.get(job.id))).join("\n")}` : "Jobs: none");
	}
	return lines.join("\n");
}

function formatJob(job: BackgroundProcessSnapshot, includeOutput: boolean, output?: CapturedOutput, liveOutputPath?: string): string {
	const lines = [`${job.id} [${job.status}] ${job.title}`, `CWD: ${job.cwd}`];
	if (job.exitCode !== undefined) lines.push(`Exit code: ${job.exitCode ?? "unknown"}`);
	if (job.errorText) lines.push(`Error: ${job.errorText}`);
	if (includeOutput) {
		lines.push(output ? formatCapturedOutput(output) : formatTailPreview(job.output));
		if (!output && liveOutputPath) lines.push(`Full output currently streaming to: ${liveOutputPath}`);
	}
	return lines.join("\n");
}

function enrichCaptureError(error: unknown, output: CapturedOutput): Error {
	const message = error instanceof Error ? error.message : String(error);
	if (!output.fullOutputPath) return error instanceof Error ? error : new Error(message);
	return new Error(`${message}\nFull command output saved to: ${output.fullOutputPath}`);
}

async function closeSession(session: ActiveSession): Promise<void> {
	if (session.closing) return;
	session.closing = true;
	await Promise.allSettled([session.manager.dispose(5000), session.rootShell?.close()]);
	try {
		await captureExec(createRemoteOperations(session.client), "sudo -k", session.remoteCwd, 5000);
	} catch {
		// Best effort: the connection may already have failed.
	}
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, 1000);
		session.client.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
		session.client.end();
	});
}
