import { randomBytes } from "node:crypto";

export interface ResolvedSshTarget {
	readonly requested: string;
	readonly hostName: string;
	readonly user: string;
	readonly port: number;
}

export function parseSshConfig(requested: string, output: string): ResolvedSshTarget {
	const values = new Map<string, string>();
	for (const line of output.split(/\r?\n/u)) {
		const separator = line.indexOf(" ");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).toLowerCase();
		if (!values.has(key)) values.set(key, line.slice(separator + 1).trim());
	}

	const hostName = values.get("hostname");
	const user = values.get("user");
	const rawPort = values.get("port") ?? "22";
	const port = Number(rawPort);
	if (!hostName || !user || !Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("OpenSSH did not return a usable hostname, user, and port");
	}
	return { requested, hostName, user, port };
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildRemoteCommand(command: string, cwd: string): string {
	return `cd -- ${shellQuote(cwd)} && exec /bin/sh -lc ${shellQuote(command)}`;
}

export function buildRootCommand(command: string, cwd: string, beginMarker: string, endMarker: string): string {
	return [
		`printf '%s\\n' ${shellQuote(beginMarker)}`,
		`cd -- ${shellQuote(cwd)} && /bin/sh -lc ${shellQuote(command)}`,
		"__pi_ssh_status=$?",
		`printf '\\n%s:%s\\n' ${shellQuote(endMarker)} "$__pi_ssh_status"`,
	].join("\n") + "\n";
}

export function randomMarker(label: string): string {
	return `__PI_SSH_${label}_${randomBytes(24).toString("hex")}__`;
}

/** Remove terminal control strings before rendering untrusted remote authentication output. */
export function sanitizeTerminalText(input: string): string {
	return input
		// OSC: ESC ] ... BEL, or ESC ] ... ST
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, "")
		// DCS/SOS/PM/APC strings terminated by ST
		.replace(/\x1b[PX^_][\s\S]*?\x1b\\/gu, "")
		// CSI and two-byte escape sequences
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
		.replace(/\x1b[@-_]/gu, "")
		.replace(/\r\n?/gu, "\n")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, "");
}

/** Return the longest suffix of text that could be the start of marker. */
export function possibleMarkerSuffixLength(text: string, marker: string): number {
	const maximum = Math.min(text.length, marker.length - 1);
	for (let length = maximum; length > 0; length--) {
		if (text.endsWith(marker.slice(0, length))) return length;
	}
	return 0;
}
