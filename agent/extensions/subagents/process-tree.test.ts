import { spawn } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { terminateProcessTree } from "./process-tree.ts";

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("process-tree termination", () => {
	test("stops a coordinator and its descendant", async () => {
		const grandchildProgram = "setInterval(() => {}, 1000);";
		const coordinatorProgram = [
			"const { spawn } = require('node:child_process');",
			`const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildProgram)}], { stdio: 'ignore' });`,
			"console.log(child.pid);",
			"setInterval(() => {}, 1000);",
		].join("\n");
		const coordinator = spawn(process.execPath, ["-e", coordinatorProgram], {
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const coordinatorPid = coordinator.pid!;
		const descendantPid = await new Promise<number>((resolve, reject) => {
			let output = "";
			const timeout = setTimeout(() => reject(new Error("No descendant PID received")), 5_000);
			coordinator.stdout.on("data", (chunk) => {
				output += chunk.toString();
				const pid = Number(output.trim());
				if (!Number.isInteger(pid)) return;
				clearTimeout(timeout);
				resolve(pid);
			});
			coordinator.once("error", reject);
		});
		const leaderExit = new Promise<void>((resolve) => coordinator.once("close", () => resolve()));

		try {
			await terminateProcessTree(coordinatorPid, () => leaderExit, 100);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(isRunning(coordinatorPid)).toBe(false);
			expect(isRunning(descendantPid)).toBe(false);
		} finally {
			if (isRunning(coordinatorPid)) {
				try { process.kill(coordinatorPid, "SIGKILL"); } catch {}
			}
			if (isRunning(descendantPid)) {
				try { process.kill(descendantPid, "SIGKILL"); } catch {}
			}
		}
	}, 10_000);
});
