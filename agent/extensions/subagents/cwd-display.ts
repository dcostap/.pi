import path from "node:path";

function comparablePath(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function customCwdDisplay(cwd: string | undefined, sessionCwd: string | undefined): string {
	if (!cwd || !sessionCwd || comparablePath(cwd) === comparablePath(sessionCwd)) return "";
	const resolvedCwd = path.resolve(cwd);
	const relative = path.relative(path.resolve(sessionCwd), resolvedCwd);
	const display = relative && relative.length < resolvedCwd.length ? relative : resolvedCwd;
	return `cwd ${display}`;
}
