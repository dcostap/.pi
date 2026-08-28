import { spawn } from "node:child_process";

export async function terminateProcessTree(
	pid: number,
	waitForLeaderExit: () => Promise<unknown>,
	graceMs = 2_000,
): Promise<void> {
	if (process.platform === "win32") {
		await new Promise<void>((resolve) => {
			let settled = false;
			let timeout: ReturnType<typeof setTimeout>;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve();
			};
			const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
				shell: false,
				stdio: "ignore",
				windowsHide: true,
			});
			timeout = setTimeout(() => {
				try { killer.kill("SIGKILL"); } catch {}
				finish();
			}, graceMs + 1_000);
			killer.once("error", finish);
			killer.once("close", finish);
		});
		await Promise.race([waitForLeaderExit(), new Promise((resolve) => setTimeout(resolve, 1_000))]);
		return;
	}

	try { process.kill(-pid, "SIGTERM"); } catch {}
	await new Promise((resolve) => setTimeout(resolve, graceMs));
	try { process.kill(-pid, "SIGKILL"); } catch {}
	await Promise.race([waitForLeaderExit(), new Promise((resolve) => setTimeout(resolve, 1_000))]);
}
