import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		expect(parsed.entries).toHaveLength(4);
		expect(parsed.entries[0]?.path).toBe("src/file with spaces.ts");
		expect(parsed.entries[1]).toMatchObject({
			path: "src/new name.ts",
			originalPath: "src/old name.ts",
			indexStatus: "R",
			worktreeStatus: ".",
		});
		expect(parsed.stagedCount).toBe(2);
		expect(parsed.unstagedCount).toBe(3);
		expect(parsed.untrackedCount).toBe(1);
		expect(parsed.conflictedCount).toBe(1);
	});

	test("uses a short object id when HEAD is detached", () => {
		const parsed = parseStatusPorcelainV2(
			"# branch.oid 0123456789abcdef\0# branch.head (detached)\0",
		);
		expect(parsed.branch).toBe("detached@0123456");
		expect(parsed.entries).toEqual([]);
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
		const calls: readonly string[][] = [];
		const mutableCalls = calls as string[][];
		const fakeRunGit: GitRunner = async (args) => {
			mutableCalls.push([...args]);
			return "# branch.oid 0123456789abcdef\0# branch.head main\0";
		};

		const snapshot = await collectGitSnapshot("C:/repo", { runGit: fakeRunGit });
		expect(snapshot).toMatchObject({ branch: "main", added: 0, removed: 0, lineStatsComplete: true });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0]).toBe("status");
	});

	test("combines one tracked diff with bounded untracked line counts", async () => {
		const root = await mkdtemp(join(tmpdir(), "git-status-widget-"));
		await writeFile(join(root, "new file.txt"), "one\ntwo\nthree");
		const calls: string[][] = [];
		const fakeRunGit: GitRunner = async (args) => {
			calls.push([...args]);
			if (args[0] === "status") {
				return `# branch.oid 0123456789abcdef\0# branch.head main\0${ORDINARY_RECORD}\0? new file.txt\0`;
			}
			if (args.includes("--show-toplevel")) return root;
			return "5\t2\tsrc/file with spaces.ts\n";
		};

		try {
			const snapshot = await collectGitSnapshot(root, { runGit: fakeRunGit });
			expect(snapshot).toMatchObject({ added: 8, removed: 2, lineStatsComplete: true });
			expect(calls).toHaveLength(3);
			expect(calls).toContainEqual(["diff", "HEAD", "--numstat", "--"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("marks line totals incomplete when normal untracked output contains a directory", async () => {
		const fakeRunGit: GitRunner = async (args) => {
			if (args[0] === "status") {
				return "# branch.oid 0123456789abcdef\0# branch.head main\0? generated/\0";
			}
			return "C:/repo";
		};
		const snapshot = await collectGitSnapshot("C:/repo", { runGit: fakeRunGit });
		expect(snapshot.lineStatsComplete).toBe(false);
	});

	test("resolves porcelain paths from the worktree root when cwd is nested", async () => {
		const root = await mkdtemp(join(tmpdir(), "git-status-widget-root-"));
		const nested = join(root, "nested");
		await mkdir(nested);
		await writeFile(join(root, "root-file.txt"), "root\nfile\n");
		const fakeRunGit: GitRunner = async (args) => {
			if (args[0] === "status") {
				return "# branch.oid 0123456789abcdef\0# branch.head main\0? root-file.txt\0";
			}
			return root;
		};

		try {
			const snapshot = await collectGitSnapshot(nested, { runGit: fakeRunGit });
			expect(snapshot).toMatchObject({ added: 2, lineStatsComplete: true });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("uses the matching empty tree for an unborn SHA-256 repository", async () => {
		const calls: string[][] = [];
		const fakeRunGit: GitRunner = async (args) => {
			calls.push([...args]);
			if (args[0] === "status") {
				return "# branch.oid (initial)\0# branch.head main\u00001 A. N... 000000 100644 100644 0000000 aaaaaaa first.txt\0";
			}
			if (args.includes("--show-object-format")) return "sha256\n";
			return "3\t1\tfirst.txt\n";
		};

		const snapshot = await collectGitSnapshot("C:/repo", { runGit: fakeRunGit });
		expect(snapshot).toMatchObject({ added: 3, removed: 1 });
		expect(calls.slice(1)).toEqual([
			["rev-parse", "--show-object-format"],
			[
				"diff",
				"6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
				"--numstat",
				"--",
			],
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
