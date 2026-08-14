import { describe, expect, test, vi } from "vitest";

import {
	type ContainerBackend,
	ExecEnv,
	type IsolateState,
	parseRawGitDiff,
} from "../../.flue/lib/exec-env.js";

function fakeState(initial?: Record<string, string>): {
	state: IsolateState;
	files: Map<string, string>;
	hangReads: () => void;
} {
	const files = new Map<string, string>(Object.entries(initial ?? {}));
	let hang = false;
	const state: IsolateState = {
		readFile: async (path) => {
			if (hang) return new Promise<never>(() => {});
			const value = files.get(path);
			if (value === undefined) throw new Error(`no such file ${path}`);
			return value;
		},
		writeFile: async (path, content) => {
			files.set(path, content);
		},
		mkdir: async () => {},
		readdirWithFileTypes: async (path) => {
			const prefix = `${path.replace(/\/+$/, "")}/`;
			const names = new Map<string, string>();
			for (const key of files.keys()) {
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				const slash = rest.indexOf("/");
				if (slash === -1) names.set(rest, "file");
				else names.set(rest.slice(0, slash), "directory");
			}
			return Array.from(names.entries(), ([name, type]) => ({ name, type }));
		},
		exists: async (path) => {
			if (files.has(path)) return true;
			const prefix = `${path.replace(/\/+$/, "")}/`;
			return [...files.keys()].some((key) => key.startsWith(prefix));
		},
		rm: async (path) => {
			const prefix = `${path.replace(/\/+$/, "")}/`;
			const keys = [...files.keys()];
			for (const key of keys) {
				if (key === path || key.startsWith(prefix)) files.delete(key);
			}
		},
		searchFiles: async (pattern, query) => {
			const root = pattern.replace(/\/\*\*\/\*$/, "");
			const out: Array<{ path: string; matches: Array<{ line: number; lineText: string }> }> = [];
			for (const [path, content] of files) {
				if (!path.startsWith(`${root}/`)) continue;
				const matches = content
					.split("\n")
					.map((lineText, index) => ({ line: index + 1, lineText }))
					.filter((entry) => entry.lineText.includes(query));
				if (matches.length > 0) out.push({ path, matches });
			}
			return out;
		},
	};
	return {
		state,
		files,
		hangReads: () => {
			hang = true;
		},
	};
}

function fakeContainer(): {
	container: ContainerBackend;
	execs: string[];
	writes: Array<{ path: string; content: string }>;
	setExecResult: (result: { exitCode: number; stdout: string; stderr: string }) => void;
	queueExecResults: (
		...results: Array<{ exitCode: number; stdout: string; stderr: string }>
	) => void;
	setReadFileBytes: (read: (path: string) => Uint8Array) => void;
	hangExec: () => void;
} {
	const execs: string[] = [];
	const writes: Array<{ path: string; content: string }> = [];
	let execResult = { exitCode: 0, stdout: "container-ran", stderr: "" };
	const queuedExecResults: Array<{ exitCode: number; stdout: string; stderr: string }> = [];
	let readFileBytes: (path: string) => Uint8Array = (_path) => new Uint8Array([1, 2, 3]);
	let hang = false;
	const container: ContainerBackend = {
		exec: async (command) => {
			execs.push(command);
			if (hang) return new Promise<never>(() => {});
			return queuedExecResults.shift() ?? execResult;
		},
		writeFile: async (path, content) => {
			writes.push({ path, content });
		},
		readFileBytes: async (path) => readFileBytes(path),
	};
	return {
		container,
		execs,
		writes,
		setExecResult: (result) => {
			execResult = result;
		},
		queueExecResults: (...results) => {
			queuedExecResults.push(...results);
		},
		setReadFileBytes: (read) => {
			readFileBytes = read;
		},
		hangExec: () => {
			hang = true;
		},
	};
}

const deadlines = { defaultTimeoutMs: 10_000, execGraceMs: 500 };
const noHydrate = async () => {};

function makeEnv(overrides?: {
	state?: IsolateState;
	container?: ContainerBackend;
	hydrateRepo?: (dir: string, ref: string) => Promise<void>;
	attachContainer?: () => Promise<ContainerBackend>;
	deadlines?: { defaultTimeoutMs: number; execGraceMs: number };
}): ExecEnv {
	return new ExecEnv({
		state: overrides?.state ?? fakeState().state,
		attachContainer:
			overrides?.attachContainer ?? (async () => overrides?.container ?? fakeContainer().container),
		hydrateRepo: overrides?.hydrateRepo ?? noHydrate,
		deadlines: overrides?.deadlines ?? deadlines,
		repoDir: "/repo",
	});
}

describe("ExecEnv container exec", () => {
	test("runs the command in the container with the repo cwd", async () => {
		const con = fakeContainer();
		const env = makeEnv({ container: con.container });

		const result = await env.exec("pnpm test");

		expect(result.stdout).toBe("container-ran");
		expect(con.execs).toEqual(["bash -o pipefail -c 'pnpm test'"]);
	});

	test("materializes logged VFS edits before the command runs", async () => {
		const fs = fakeState({ "/repo/src/x.ts": "v1" });
		const con = fakeContainer();
		const env = makeEnv({ state: fs.state, container: con.container });

		await env.writeFile("/repo/src/x.ts", "v2");
		await env.exec("pnpm test");

		expect(con.writes).toEqual([{ path: "/repo/src/x.ts", content: "v2" }]);
		expect(con.execs).toEqual(["bash -o pipefail -c 'pnpm test'"]);
	});

	test("runs pipelines with pipefail so a failed producer cannot look successful", async () => {
		const con = fakeContainer();
		const env = makeEnv({ container: con.container });

		await env.exec("pnpm test 2>&1 | tail -20");

		expect(con.execs).toEqual(["bash -o pipefail -c 'pnpm test 2>&1 | tail -20'"]);
	});

	test("rejects and discards source changes made by a verification command", async () => {
		const con = fakeContainer();
		con.queueExecResults(
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "before-tree\n", stderr: "" },
			{ exitCode: 0, stdout: "formatted", stderr: "" },
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "after-tree\n", stderr: "" },
			{ exitCode: 0, stdout: "", stderr: "" },
		);
		const env = makeEnv({ container: con.container });

		await expect(env.runCheck("pnpm format")).rejects.toThrow(
			/verification command modified the candidate/,
		);
		expect(con.execs.at(-1)).toContain("git reset --hard HEAD");
	});

	test("returns the verified candidate tree for a read-only check", async () => {
		const con = fakeContainer();
		con.queueExecResults(
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "candidate-tree\n", stderr: "" },
			{ exitCode: 0, stdout: "passed", stderr: "" },
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "candidate-tree\n", stderr: "" },
		);
		const env = makeEnv({ container: con.container });

		await expect(env.runCheck("pnpm format:check")).resolves.toEqual({
			result: { exitCode: 0, stdout: "passed", stderr: "" },
			candidateTreeSha: "candidate-tree",
		});
	});

	test("an edit in one instance is materialized when another execs over the same VFS", async () => {
		const fs = fakeState({ "/repo/src/x.ts": "old" });
		const con = fakeContainer();
		const envA = makeEnv({ state: fs.state, container: con.container });
		await envA.edit("/repo/src/x.ts", "old", "new");

		const envB = makeEnv({ state: fs.state, container: con.container });
		await envB.exec("pnpm test");

		expect(con.writes).toEqual([{ path: "/repo/src/x.ts", content: "new" }]);
	});

	test("replay sends the current VFS content, and a repeat write logs once", async () => {
		const fs = fakeState({ "/repo/src/x.ts": "v1" });
		const con = fakeContainer();
		const env = makeEnv({ state: fs.state, container: con.container });

		await env.writeFile("/repo/src/x.ts", "v2");
		await env.exec("pnpm test");
		await env.writeFile("/repo/src/x.ts", "v3");
		await env.exec("pnpm lint");

		expect(con.writes).toEqual([
			{ path: "/repo/src/x.ts", content: "v2" },
			{ path: "/repo/src/x.ts", content: "v3" },
		]);
	});

	test("writes outside the repo are not materialized", async () => {
		const fs = fakeState();
		const con = fakeContainer();
		const env = makeEnv({ state: fs.state, container: con.container });

		await env.writeFile("/scratch/notes.md", "plan");
		await env.exec("pnpm test");

		expect(con.writes).toEqual([]);
	});
});

describe("ExecEnv candidate snapshots", () => {
	const zeroSha = "0".repeat(40);
	const blobSha = "1".repeat(40);

	test("parses the null-delimited raw format emitted by git diff --cached", () => {
		const raw = [
			`:000000 100644 ${zeroSha} ${blobSha} A`,
			"src/new file.ts",
			`:100755 100755 ${blobSha} ${blobSha} M`,
			"bin/run",
			`:100644 000000 ${blobSha} ${zeroSha} D`,
			"src/old.ts",
			"",
		].join("\0");

		expect(parseRawGitDiff(raw)).toEqual([
			{ path: "src/new file.ts", mode: "100644", deleted: false, blobSha },
			{ path: "bin/run", mode: "100755", deleted: false, blobSha },
			{ path: "src/old.ts", mode: "100644", deleted: true, blobSha: null },
		]);
	});

	test("snapshots added and deleted files from the staged diff", async () => {
		const stagedBlobSha = "3e757656cf36eca53338e520d134963a44f793f8";
		const raw = [
			`:000000 100644 ${zeroSha} ${stagedBlobSha} A`,
			"src/new.ts",
			`:100644 000000 ${blobSha} ${zeroSha} D`,
			"src/old.ts",
			"",
		].join("\0");
		const con = fakeContainer();
		con.queueExecResults(
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "base-commit\n", stderr: "" },
			{ exitCode: 0, stdout: "candidate-tree\n", stderr: "" },
			{ exitCode: 0, stdout: raw, stderr: "" },
		);
		con.setReadFileBytes(() => new TextEncoder().encode("new\n"));
		const env = makeEnv({ container: con.container });

		await expect(env.snapshotCandidate()).resolves.toEqual({
			baseCommitSha: "base-commit",
			treeSha: "candidate-tree",
			changes: [
				{ path: "src/new.ts", mode: "100644", content: new TextEncoder().encode("new\n") },
				{ path: "src/old.ts", mode: "100644", content: null },
			],
		});
		expect(
			con.execs.some(
				(command) => command.includes("git cat-file blob") && command.includes(stagedBlobSha),
			),
		).toBe(true);
	});

	test("rejects content that does not match the staged blob", async () => {
		const con = fakeContainer();
		con.queueExecResults(
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "base\n", stderr: "" },
			{ exitCode: 0, stdout: "candidate-tree\n", stderr: "" },
			{
				exitCode: 0,
				stdout: `:000000 100644 ${zeroSha} 3e757656cf36eca53338e520d134963a44f793f8 A\0src/new.ts\0`,
				stderr: "",
			},
		);
		con.setReadFileBytes(() => new TextEncoder().encode("changed after staging\n"));

		await expect(makeEnv({ container: con.container }).snapshotCandidate()).rejects.toThrow(
			/does not match staged blob/,
		);
	});

	test("rejects malformed raw diffs, symlinks, and workflow changes", async () => {
		expect(() => parseRawGitDiff(`:000000 100644 ${zeroSha} ${blobSha} A\0src/x.ts`)).toThrow(
			/malformed staged diff/,
		);
		expect(() => parseRawGitDiff(`:000000 120000 ${zeroSha} ${blobSha} A\0link\0`)).toThrow(
			/symlink/,
		);

		const con = fakeContainer();
		con.queueExecResults(
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "base\n", stderr: "" },
			{ exitCode: 0, stdout: "candidate-tree\n", stderr: "" },
			{
				exitCode: 0,
				stdout: `:000000 100644 ${zeroSha} ${blobSha} A\0.github/workflows/pwn.yml\0`,
				stderr: "",
			},
		);
		await expect(makeEnv({ container: con.container }).snapshotCandidate()).rejects.toThrow(
			/cannot publish path/,
		);
	});

	test("rejects a candidate file larger than the publication limit", async () => {
		const con = fakeContainer();
		con.queueExecResults(
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "base\n", stderr: "" },
			{ exitCode: 0, stdout: "candidate-tree\n", stderr: "" },
			{
				exitCode: 0,
				stdout: `:000000 100644 ${zeroSha} ${blobSha} A\0large.bin\0`,
				stderr: "",
			},
		);
		con.setReadFileBytes(() => new Uint8Array(2 * 1024 * 1024 + 1));

		await expect(makeEnv({ container: con.container }).snapshotCandidate()).rejects.toThrow(
			/file large\.bin is .* limit/,
		);
	});
});

describe("ExecEnv deadlines", () => {
	test("container exec adds the grace margin to its own timeout", async () => {
		vi.useFakeTimers();
		try {
			const con = fakeContainer();
			con.hangExec();
			const env = makeEnv({
				container: con.container,
				deadlines: { defaultTimeoutMs: 1_000, execGraceMs: 5 },
			});
			const pending = env.exec("vitest", { timeoutMs: 10 });
			const assertion = expect(pending).rejects.toThrow("container exec timed out after 15ms");
			await vi.advanceTimersByTimeAsync(20);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});

	test("a hung VFS read rejects with the labelled deadline error", async () => {
		vi.useFakeTimers();
		try {
			const fs = fakeState({ "/repo/a.ts": "x" });
			fs.hangReads();
			const env = makeEnv({
				state: fs.state,
				deadlines: { defaultTimeoutMs: 50, execGraceMs: 5 },
			});
			const pending = env.readFile("/repo/a.ts");
			const assertion = expect(pending).rejects.toThrow("VFS readFile timed out after 50ms");
			await vi.advanceTimersByTimeAsync(60);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("ExecEnv container lifecycle", () => {
	test("the container is attached lazily and reused across execs", async () => {
		const con = fakeContainer();
		const attach = vi.fn(async () => con.container);
		const env = makeEnv({ attachContainer: attach });

		expect(attach).not.toHaveBeenCalled();
		await env.exec("pnpm install");
		await env.exec("pnpm test");

		expect(attach).toHaveBeenCalledTimes(1);
		expect(con.execs).toEqual([
			"bash -o pipefail -c 'pnpm install'",
			"bash -o pipefail -c 'pnpm test'",
		]);
	});
});

describe("ExecEnv VFS tools", () => {
	test("edit replaces a unique target and throws when absent or ambiguous", async () => {
		const fs = fakeState({ "/repo/a.ts": "one two one" });
		const env = makeEnv({ state: fs.state });

		await expect(env.edit("/repo/a.ts", "missing", "x")).rejects.toThrow("edit target not found");
		await expect(env.edit("/repo/a.ts", "one", "x")).rejects.toThrow("not unique");
		await env.edit("/repo/a.ts", "two", "three");
		expect(fs.files.get("/repo/a.ts")).toBe("one three one");
	});

	test("ls marks directories with a type", async () => {
		const fs = fakeState({ "/repo/src/a.ts": "x", "/repo/readme.md": "y" });
		const env = makeEnv({ state: fs.state });

		const entries = await env.ls("/repo");

		expect(entries).toEqual(
			expect.arrayContaining([
				{ name: "src", type: "directory" },
				{ name: "readme.md", type: "file" },
			]),
		);
	});

	test("grep searches under the path and maps matches to path/line/text", async () => {
		const fs = fakeState({
			"/repo/src/a.ts": "const x = 1;\n// TODO fix\n",
			"/repo/src/b.ts": "clean\n",
		});
		const env = makeEnv({ state: fs.state });

		const matches = await env.grep("TODO", "/repo");

		expect(matches).toEqual([{ path: "/repo/src/a.ts", line: 2, text: "// TODO fix" }]);
	});
});

describe("ExecEnv ensureRepo", () => {
	test("hydrates once per ref and records the marker", async () => {
		const fs = fakeState();
		const calls: Array<{ dir: string; ref: string }> = [];
		const env = makeEnv({
			state: fs.state,
			hydrateRepo: async (dir, ref) => {
				calls.push({ dir, ref });
			},
		});

		await env.ensureRepo({ dir: "/repo", ref: "main" });
		await env.ensureRepo({ dir: "/repo", ref: "main" });

		expect(calls).toEqual([{ dir: "/repo", ref: "main" }]);
		expect(fs.files.get("/.emdash-bot/hydrated")).toBe("main");
	});

	test("defaults the ref to main", async () => {
		const calls: string[] = [];
		const env = makeEnv({
			hydrateRepo: async (_dir, ref) => {
				calls.push(ref);
			},
		});

		await env.ensureRepo({ dir: "/repo" });

		expect(calls).toEqual(["main"]);
	});

	test("a different ref discards the tree, rehydrates, and resets the change log", async () => {
		const fs = fakeState({ "/repo/src/a.ts": "v1" });
		const con = fakeContainer();
		const calls: string[] = [];
		const env = makeEnv({
			state: fs.state,
			container: con.container,
			hydrateRepo: async (dir, ref) => {
				calls.push(ref);
				fs.files.set(`${dir}/src/a.ts`, `content@${ref}`);
			},
		});

		await env.ensureRepo({ dir: "/repo", ref: "main" });
		await env.writeFile("/repo/src/a.ts", "edited");
		await env.ensureRepo({ dir: "/repo", ref: "c0c6c72e" });
		await env.exec("pnpm test");

		expect(calls).toEqual(["main", "c0c6c72e"]);
		expect(fs.files.get("/.emdash-bot/hydrated")).toBe("c0c6c72e");
		expect(con.writes).toEqual([]);
	});
});

describe("ExecEnv artifact egress", () => {
	test("reads a bare artifact name from under .bot-artifacts", async () => {
		const con = fakeContainer();
		const env = makeEnv({ container: con.container });

		const bytes = await env.readArtifact("shot.png");

		expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
		expect(con.execs).toEqual([
			"test -f '/repo/.bot-artifacts/shot.png' && test ! -L '/repo/.bot-artifacts/shot.png'",
		]);
	});

	test("rejects any name that could escape the artifacts directory", async () => {
		const env = makeEnv();
		for (const name of ["", ".", "..", "a/b.png", "..\\evil", "/abs.png"]) {
			await expect(env.readArtifact(name)).rejects.toThrow("invalid artifact name");
		}
	});

	test("refuses a symlinked artifact", async () => {
		const con = fakeContainer();
		con.setExecResult({ exitCode: 1, stdout: "", stderr: "" });
		const env = makeEnv({ container: con.container });

		await expect(env.readArtifact("link.png")).rejects.toThrow("artifact is not a regular file");
	});
});
