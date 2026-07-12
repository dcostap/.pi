import {
	createWriteToolDefinition,
	type ExtensionAPI,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { mkdir, stat, writeFile } from "node:fs/promises";

/**
 * Work around Bun on Windows throwing EEXIST for
 * mkdir(path, { recursive: true }) when an existing directory has the
 * Windows ReadOnly attribute (the Desktop folder commonly does).
 */
const windowsSafeWriteOperations: WriteOperations = {
	async mkdir(dir) {
		try {
			await mkdir(dir, { recursive: true });
		} catch (error) {
			if (
				process.platform !== "win32" ||
				typeof error !== "object" ||
				error === null ||
				!("code" in error) ||
				error.code !== "EEXIST"
			) {
				throw error;
			}

			// Suppress Bun's false EEXIST only when the target really is an
			// existing directory. A file at this path remains a real error.
			const info = await stat(dir);
			if (!info.isDirectory()) throw error;
		}
	},

	async writeFile(path, content) {
		await writeFile(path, content, "utf8");
	},
};

export default function (pi: ExtensionAPI) {
	const publishOperations = () => {
		pi.events.emit("write-operations:available", windowsSafeWriteOperations);
	};

	// Request/response makes composition independent of extension load order.
	pi.events.on("write-operations:request", publishOperations);
	publishOperations();

	pi.on("session_start", (_event, ctx) => {
		const hasExtensionWrite = pi
			.getAllTools()
			.some((tool) => tool.name === "write" && tool.sourceInfo.source !== "builtin");

		// When another extension (such as tool-token-progress) already owns the
		// write override, it receives the operations above. Otherwise this
		// extension installs the safe native write definition itself.
		if (!hasExtensionWrite) {
			pi.registerTool(
				createWriteToolDefinition(ctx.cwd, {
					operations: windowsSafeWriteOperations,
				}),
			);
		}
	});
}
