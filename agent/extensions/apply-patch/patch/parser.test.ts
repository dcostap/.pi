import { describe, expect, test } from "bun:test";
import { parsePatchActions } from "./parser.ts";

describe("Codex-compatible apply_patch parsing", () => {
	test("allows ordered actions to target the same path", () => {
		const actions = parsePatchActions({
			text: [
				"*** Begin Patch",
				"*** Delete File: tools/coff.py",
				"*** Add File: tools/coff.py",
				"+replacement",
				"*** End Patch",
			].join("\n"),
		});

		expect(actions).toEqual([
			{ type: "delete", path: "tools/coff.py" },
			{ type: "add", path: "tools/coff.py", newFile: "replacement\n" },
		]);
	});

	test("accepts CRLF and whitespace-padded top-level markers", () => {
		const actions = parsePatchActions({
			text: [
				"*** Begin Patch ",
				"  *** Add File: padded.txt  ",
				"+content",
				" *** End Patch",
			].join("\r\n"),
		});

		expect(actions).toEqual([
			{ type: "add", path: "padded.txt", newFile: "content\n" },
		]);
	});

	test("accepts the environment preamble", () => {
		const actions = parsePatchActions({
			text: [
				"*** Begin Patch",
				"*** Environment ID: remote",
				"*** Add File: hello.txt",
				"+hello",
				"*** End Patch",
			].join("\n"),
		});

		expect(actions[0]).toEqual({ type: "add", path: "hello.txt", newFile: "hello\n" });
	});

	test("accepts Codex's lenient heredoc-shaped argument", () => {
		const actions = parsePatchActions({
			text: [
				"<<'EOF'",
				"*** Begin Patch",
				"*** Delete File: old.txt",
				"*** End Patch",
				"EOF",
			].join("\n"),
		});

		expect(actions).toEqual([{ type: "delete", path: "old.txt" }]);
	});

	test("preserves literal quote and at-sign path characters", () => {
		const actions = parsePatchActions({
			text: [
				"*** Begin Patch",
				"*** Add File: 'quoted.txt'",
				"+quoted",
				"*** Add File: @at.txt",
				"+at",
				"*** End Patch",
			].join("\n"),
		});

		expect(actions.map((action) => action.path)).toEqual(["'quoted.txt'", "@at.txt"]);
	});

	test("requires exact patch boundary markers", () => {
		expect(() => parsePatchActions({
			text: "*** Begin Patch garbage\n*** Add File: file.txt\n+x\n*** End Patch",
		})).toThrow("Invalid patch text");
	});
});
