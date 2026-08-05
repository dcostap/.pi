import { describe, expect, test } from "bun:test";
import {
	collectGitSnapshot,
	parseNumstat,
	parseStatusPorcelainV2,
	runGit,
	type GitRunner,
} from "./git.ts";

const ORDINARY_RECORD = "1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb src/file with spaces.ts";
const RENAME_RECORD = "2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 src/new name.ts";
const CONFLICT_RECORD = "u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc src/conflict.ts";

describe("porcelain v2 parsing", () => {
	test("parses branch headers and all relevant record types", () => {
		const parsed = parseStatusPorcelainV2(
			[
				"# branch.oid 0123456789abcdef\0# branch.head feature/status\0",
				`${ORDINARY_RECORD}\0`,
				`${RENAME_RECORD}\0src/old name.ts\0`,
				"? newly created.txt\0",
				`${CONFLICT_RECORD}\0`,
				"! ignored.log\0",
			].join(""),
		);

		expect(parsed.branch).toBe("feature/status");
		expect(parsed.changeCount).toBe(4);
		expect(parsed.hasTrackedChanges).toBe(true);
		expect(parsed.stagedCount).toBe(1);
		expect(parsed.unstagedCount).toBe(2);
		expect(parsed.untrackedCount).toBe(1);
		expect(parsed.conflictedCount).toBe(1);
	});

	test("uses a short object id when HEAD is detached", () => {
		const parsed = parseStatusPorcelainV2(
			"# branch.oid 0123456789abcdef\0# branch.head (detached)\0",
		);
		expect(parsed.branch).toBe("detached@0123456");
		expect(parsed.changeCount).toBe(0);
	});

	test("aggregates large status output without retaining one object per path", () => {
		const records = Array.from({ length: 50_000 }, (_, index) =>
			`1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb src/file-${index}.ts\0`,
		).join("");
		const parsed = parseStatusPorcelainV2(
			`# branch.oid 0123456789abcdef\0# branch.head main\0${records}`,
		);
		expect(parsed.changeCount).toBe(50_000);
		expect(parsed.unstagedCount).toBe(50_000);
	});

	test("handles an unborn branch without inventing a commit", () => {
		const parsed = parseStatusPorcelainV2("# branch.oid (initial)\0# branch.head main\0");
		expect(parsed.branch).toBe("main");
		expect(parsed.headOid).toBe("(initial)");
	});
});

describe("numstat parsing", () => {
	test("sums text changes and ignores binary markers and malformed lines", () => {
		expect(parseNumstat("12\t3\ta.ts\n-\t-\timage.png\n4\t0\tb.ts\ninvalid\n")).toEqual({
			added: 16,
			removed: 3,
		});
	});
});

describe("snapshot collection", () => {
	test("runs only status for a clean worktree", async () => {
		const calls: string[][] = [];
		const fakeRunGit: GitRunner = async (args) => {
			calls.push([...args]);
			return "# branch.oid 0123456789abcdef\0# branch.head main\0";
		};

		const snapshot = await collectGitSnapshot("C:/repo", { runGit: fakeRunGit });
		expect(snapshot).toMatchObject({ branch: "main", added: 0, removed: 0, lineStatsComplete: true });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0]).toBe("status");
	});

	test("combines staged and unstaged line activity and marks untracked lines approximate", async () => {
		const calls: string[][] = [];
		const fakeRunGit: GitRunner = async (args) => {
			calls.push([...args]);
			if (args[0] === "status") {
				return `# branch.oid 0123456789abcdef\0# branch.head main\0${ORDINARY_RECORD}\0? new file.txt\0`;
			}
			return args.includes("--cached")
				? "2\t1\tsrc/file with spaces.ts\n"
				: "5\t2\tsrc/file with spaces.ts\n";
		};

		const snapshot = await collectGitSnapshot("C:/repo", { runGit: fakeRunGit });
		expect(snapshot).toMatchObject({ added: 7, removed: 3, lineStatsComplete: false });
		expect(calls).toHaveLength(3);
		expect(calls).toContainEqual(["diff", "--numstat", "--"]);
		expect(calls).toContainEqual(["diff", "--cached", "--numstat", "--"]);
	});

	test("marks line totals incomplete when normal untracked output contains a directory", async () => {
		const fakeRunGit: GitRunner = async () =>
			"# branch.oid 0123456789abcdef\0# branch.head main\0? generated/\0";
		const snapshot = await collectGitSnapshot("C:/repo", { runGit: fakeRunGit });
		expect(snapshot.lineStatsComplete).toBe(false);
	});

	test("uses the same staged plus unstaged semantics for an unborn repository", async () => {
		const calls: string[][] = [];
		const fakeRunGit: GitRunner = async (args) => {
			calls.push([...args]);
			if (args[0] === "status") {
				return "# branch.oid (initial)\0# branch.head main\u00001 AM N... 000000 100644 100644 0000000 aaaaaaa first.txt\0";
			}
			return args.includes("--cached") ? "2\t0\tfirst.txt\n" : "1\t1\tfirst.txt\n";
		};

		const snapshot = await collectGitSnapshot("C:/repo", { runGit: fakeRunGit });
		expect(snapshot).toMatchObject({ added: 3, removed: 1 });
		expect(calls.slice(1)).toEqual([
			["diff", "--numstat", "--"],
			["diff", "--cached", "--numstat", "--"],
		]);
	});

	test("does not scan tracked files when the worktree only has untracked entries", async () => {
		const calls: string[][] = [];
		const fakeRunGit: GitRunner = async (args) => {
			calls.push([...args]);
			return args[0] === "status"
				? "# branch.oid 0123456789abcdef\0# branch.head main\0? generated/\0"
				: "C:/repo";
		};
		await collectGitSnapshot("C:/repo", { runGit: fakeRunGit });
		expect(calls.some((args) => args[0] === "diff")).toBe(false);
	});

	test("honors an already-aborted signal before spawning Git", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(runGit(["status"], process.cwd(), controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
	});
});
