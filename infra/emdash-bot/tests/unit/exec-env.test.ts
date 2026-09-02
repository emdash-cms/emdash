import type { Sandbox } from "@cloudflare/sandbox";
import { describe, expect, test, vi } from "vitest";

import {
	type ContainerBackend,
	ExecEnv,
	fromSandbox,
	type IsolateState,
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
	queueReadyResults: (...results: Array<boolean | Error>) => void;
	hangExec: () => void;
} {
	const execs: string[] = [];
	const writes: Array<{ path: string; content: string }> = [];
	let execResult = { exitCode: 0, stdout: "container-ran", stderr: "" };
	const queuedExecResults: Array<{ exitCode: number; stdout: string; stderr: string }> = [];
	let readFileBytes: (path: string) => Uint8Array = (_path) => new Uint8Array([1, 2, 3]);
	const readyResults: Array<boolean | Error> = [];
	let hang = false;
	const container: ContainerBackend = {
		isReady: async () => {
			const result = readyResults.shift() ?? true;
			if (result instanceof Error) throw result;
			return result;
		},
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
		queueReadyResults: (...results) => {
			readyResults.push(...results);
		},
		hangExec: () => {
			hang = true;
		},
	};
}

const deadlines = { defaultTimeoutMs: 10_000, attachTimeoutMs: 20_000, execGraceMs: 500 };
const noHydrate = async () => {};

function makeEnv(overrides?: {
	state?: IsolateState;
	container?: ContainerBackend;
	hydrateRepo?: (dir: string, ref: string) => Promise<void>;
	attachContainer?: () => Promise<ContainerBackend>;
	deadlines?: { defaultTimeoutMs: number; attachTimeoutMs: number; execGraceMs: number };
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

function base64Utf8(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function sandboxFileStream(content: string): ReadableStream<Uint8Array> {
	const size = new TextEncoder().encode(content).byteLength;
	const events = [
		{ type: "metadata", mimeType: "text/plain", size, isBinary: false, encoding: "utf-8" },
		{ type: "chunk", data: content },
		{ type: "complete" },
	];
	const payload = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(payload));
			controller.close();
		},
	});
}

describe("Sandbox container adapter", () => {
	test("returns exact file bytes rather than the file stream protocol", async () => {
		const content = "# r\u00e9sum\u00e9 \ud83d\ude80\n";
		const sandbox = {
			readFile: async () => ({ content: base64Utf8(content) }),
			readFileStream: async () => sandboxFileStream(content),
		} as unknown as Sandbox;

		const bytes = await fromSandbox(sandbox).readFileBytes("/tmp/candidate");

		expect(bytes).toEqual(new TextEncoder().encode(content));
	});
});

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

		await expect(env.execReadOnly("pnpm format")).rejects.toThrow(/command modified the candidate/);
		expect(con.execs.at(-1)).toContain("git reset --hard HEAD");
	});

	test("rejects tracked source changes from exploratory commands", async () => {
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

		await expect(env.execReadOnly("pnpm format")).rejects.toThrow(
			/container command modified the candidate/,
		);
		expect(con.execs.at(-1)).toContain("git reset --hard HEAD");
	});

	test("returns the command result when a read-only check leaves the candidate unchanged", async () => {
		const con = fakeContainer();
		con.queueExecResults(
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "candidate-tree\n", stderr: "" },
			{ exitCode: 0, stdout: "passed", stderr: "" },
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "candidate-tree\n", stderr: "" },
		);
		const env = makeEnv({ container: con.container });

		await expect(env.execReadOnly("pnpm format:check")).resolves.toEqual({
			exitCode: 0,
			stdout: "passed",
			stderr: "",
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

	test("serializes parallel edits so every changed path is materialized", async () => {
		const fs = fakeState({ "/repo/a.ts": "a", "/repo/b.ts": "b" });
		const con = fakeContainer();
		const env = makeEnv({ state: fs.state, container: con.container });

		await Promise.all([
			env.writeFile("/repo/a.ts", "changed-a"),
			env.writeFile("/repo/b.ts", "changed-b"),
		]);
		await env.exec("pnpm test");

		expect(con.writes).toEqual([
			{ path: "/repo/a.ts", content: "changed-a" },
			{ path: "/repo/b.ts", content: "changed-b" },
		]);
	});

	test("rejects traversal and Git metadata paths before writing to the VFS", async () => {
		const fs = fakeState();
		const env = makeEnv({ state: fs.state });

		await expect(env.writeFile("/repo/../escape", "x")).rejects.toThrow(/cannot edit path/);
		await expect(env.writeFile("/repo/.git/config", "x")).rejects.toThrow(/cannot edit path/);
		await expect(env.writeFile("/repo/./.git/config", "x")).rejects.toThrow(/cannot edit path/);
		await expect(env.writeFile("/repo/.github//workflows/pwn.yml", "x")).rejects.toThrow(
			/cannot edit path/,
		);
		expect(fs.files.has("/repo/../escape")).toBe(false);
		expect(fs.files.has("/repo/.git/config")).toBe(false);
		expect(fs.files.has("/repo/./.git/config")).toBe(false);
	});
});

describe("ExecEnv candidate publication", () => {
	test("commits and pushes the durable candidate through the scoped git proxy", async () => {
		const con = fakeContainer();
		con.queueExecResults(
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "base-commit\n", stderr: "" },
			{ exitCode: 0, stdout: "candidate-tree\n", stderr: "" },
			{ exitCode: 0, stdout: `${base64Utf8("src/base-url.ts\0")}\n`, stderr: "" },
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "[detached HEAD commit-sha] Fix base URLs\n", stderr: "" },
			{ exitCode: 0, stdout: "commit-sha\n", stderr: "" },
			{ exitCode: 0, stdout: "To github.com:emdash-cms/emdash.git\n", stderr: "" },
			{
				exitCode: 0,
				stdout: "commit-sha\trefs/heads/bot/fix-2482\n",
				stderr: "",
			},
		);
		const env = makeEnv({
			state: fakeState({ "/repo/src/base-url.ts": "export {};\n" }).state,
			container: con.container,
		});

		await expect(
			env.publishCandidate({
				branch: "bot/fix-2482",
				runId: "run-2482",
				commitMessage: "Fix base URLs",
				baseRef: "base-commit",
				expectedPreviousSha: null,
			}),
		).resolves.toEqual({
			branch: "bot/fix-2482",
			commitSha: "commit-sha",
			files: ["src/base-url.ts"],
		});

		expect(
			con.execs.some(
				(command) => command.includes("git reset --hard") && command.includes("base-commit"),
			),
		).toBe(true);
		expect(
			con.execs.some(
				(command) =>
					command.includes("git commit --no-verify") && command.includes("EmDash-Run: run-2482"),
			),
		).toBe(true);
		expect(
			con.execs.some((command) => command.includes("--force-with-lease=refs/heads/bot/fix-2482:")),
		).toBe(true);
	});

	test("reuses an idempotent publication with the same run marker and tree", async () => {
		const con = fakeContainer();
		con.queueExecResults(
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "base-commit\n", stderr: "" },
			{ exitCode: 0, stdout: "candidate-tree\n", stderr: "" },
			{ exitCode: 0, stdout: `${base64Utf8("src/base-url.ts\0")}\n`, stderr: "" },
			{
				exitCode: 0,
				stdout: "published-sha\trefs/heads/bot/fix-2482\n",
				stderr: "",
			},
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "Fix base URLs\n\nEmDash-Run: run-2482\n", stderr: "" },
			{ exitCode: 0, stdout: "candidate-tree\n", stderr: "" },
		);
		const env = makeEnv({
			state: fakeState({ "/repo/src/base-url.ts": "export {};\n" }).state,
			container: con.container,
		});

		await expect(
			env.publishCandidate({
				branch: "bot/fix-2482",
				runId: "run-2482",
				commitMessage: "Fix base URLs",
				baseRef: "base-commit",
				expectedPreviousSha: null,
			}),
		).resolves.toEqual({
			branch: "bot/fix-2482",
			commitSha: "published-sha",
			files: ["src/base-url.ts"],
		});
		expect(con.execs.some((command) => command.includes("git commit --no-verify"))).toBe(false);
		expect(con.execs.some((command) => command.includes("git push"))).toBe(false);
	});

	test("refuses to overwrite a candidate branch changed by another run", async () => {
		const con = fakeContainer();
		con.queueExecResults(
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "base-commit\n", stderr: "" },
			{ exitCode: 0, stdout: "candidate-tree\n", stderr: "" },
			{ exitCode: 0, stdout: `${base64Utf8("src/base-url.ts\0")}\n`, stderr: "" },
			{
				exitCode: 0,
				stdout: "other-sha\trefs/heads/bot/fix-2482\n",
				stderr: "",
			},
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "A different run\n", stderr: "" },
			{ exitCode: 0, stdout: "other-tree\n", stderr: "" },
		);
		const env = makeEnv({
			state: fakeState({ "/repo/src/base-url.ts": "export {};\n" }).state,
			container: con.container,
		});

		await expect(
			env.publishCandidate({
				branch: "bot/fix-2482",
				runId: "run-2482",
				commitMessage: "Fix base URLs",
				baseRef: "base-commit",
				expectedPreviousSha: null,
			}),
		).rejects.toThrow(/candidate branch changed/);
		expect(con.execs.some((command) => command.includes("git commit --no-verify"))).toBe(false);
		expect(con.execs.some((command) => command.includes("git push"))).toBe(false);
	});

	test("rejects forbidden candidate paths before committing", async () => {
		const con = fakeContainer();
		con.queueExecResults(
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "base-commit\n", stderr: "" },
			{ exitCode: 0, stdout: "candidate-tree\n", stderr: "" },
			{
				exitCode: 0,
				stdout: `${base64Utf8(".github/workflows/pwn.yml\0")}\n`,
				stderr: "",
			},
		);
		const env = makeEnv({ container: con.container });

		await expect(
			env.publishCandidate({
				branch: "bot/fix-2482",
				runId: "run-2482",
				commitMessage: "Unsafe change",
				baseRef: "base-commit",
				expectedPreviousSha: null,
			}),
		).rejects.toThrow("candidate cannot publish path");
		expect(con.execs.some((command) => command.includes("git commit --no-verify"))).toBe(false);
	});
});

describe("ExecEnv deadlines", () => {
	test("uses the dedicated attachment deadline for slow container setup", async () => {
		vi.useFakeTimers();
		try {
			const env = makeEnv({
				attachContainer: () => new Promise<never>(() => {}),
				deadlines: { defaultTimeoutMs: 50, attachTimeoutMs: 100, execGraceMs: 5 },
			});
			const pending = env.exec("pnpm test");
			const assertion = expect(pending).rejects.toThrow("container attach timed out after 100ms");
			await vi.advanceTimersByTimeAsync(110);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});

	test("container exec adds the grace margin to its own timeout", async () => {
		vi.useFakeTimers();
		try {
			const con = fakeContainer();
			con.hangExec();
			const env = makeEnv({
				container: con.container,
				deadlines: { defaultTimeoutMs: 1_000, attachTimeoutMs: 2_000, execGraceMs: 5 },
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
				deadlines: { defaultTimeoutMs: 50, attachTimeoutMs: 100, execGraceMs: 5 },
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
	test("prepares the container once and reuses it for later commands", async () => {
		const con = fakeContainer();
		const attach = vi.fn(async () => con.container);
		const env = makeEnv({ attachContainer: attach });

		await env.ensureContainerReady();
		await env.ensureContainerReady();
		await env.exec("pnpm test");

		expect(attach).toHaveBeenCalledTimes(1);
		expect(con.execs).toEqual(["bash -o pipefail -c 'pnpm test'"]);
	});

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

	test("reattaches when the cached container checkout is no longer ready", async () => {
		const fs = fakeState({ "/repo/src/x.ts": "old" });
		const first = fakeContainer();
		const replacement = fakeContainer();
		first.queueReadyResults(true, false);
		const attach = vi
			.fn<() => Promise<ContainerBackend>>()
			.mockResolvedValueOnce(first.container)
			.mockResolvedValueOnce(replacement.container);
		const env = makeEnv({ state: fs.state, attachContainer: attach });

		await env.exec("pnpm install");
		await env.writeFile("/repo/src/x.ts", "new");
		await env.exec("pnpm test");

		expect(attach).toHaveBeenCalledTimes(2);
		expect(first.execs).toEqual(["bash -o pipefail -c 'pnpm install'"]);
		expect(replacement.writes).toEqual([{ path: "/repo/src/x.ts", content: "new" }]);
		expect(replacement.execs).toEqual(["bash -o pipefail -c 'pnpm test'"]);
	});

	test("shares one reattachment across concurrent commands", async () => {
		const first = fakeContainer();
		const replacement = fakeContainer();
		first.queueReadyResults(false, false);
		const attach = vi
			.fn<() => Promise<ContainerBackend>>()
			.mockResolvedValueOnce(first.container)
			.mockResolvedValueOnce(replacement.container);
		const env = makeEnv({ attachContainer: attach });

		await Promise.all([env.exec("pnpm test"), env.exec("pnpm lint")]);

		expect(attach).toHaveBeenCalledTimes(2);
		expect(replacement.execs).toEqual(
			expect.arrayContaining([
				"bash -o pipefail -c 'pnpm test'",
				"bash -o pipefail -c 'pnpm lint'",
			]),
		);
	});

	test("reattaches when the readiness probe rejects", async () => {
		const first = fakeContainer();
		const replacement = fakeContainer();
		first.queueReadyResults(new Error("container replaced"));
		const attach = vi
			.fn<() => Promise<ContainerBackend>>()
			.mockResolvedValueOnce(first.container)
			.mockResolvedValueOnce(replacement.container);
		const env = makeEnv({ attachContainer: attach });

		await env.exec("pnpm test");

		expect(attach).toHaveBeenCalledTimes(2);
		expect(replacement.execs).toEqual(["bash -o pipefail -c 'pnpm test'"]);
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

	test("bounds a stalled workspace hydration", async () => {
		vi.useFakeTimers();
		try {
			const env = makeEnv({
				hydrateRepo: () => new Promise<never>(() => {}),
				deadlines: { defaultTimeoutMs: 50, attachTimeoutMs: 100, execGraceMs: 5 },
			});
			const pending = env.ensureRepo({ dir: "/repo", ref: "main" });
			const assertion = expect(pending).rejects.toThrow("VFS hydrateRepo timed out after 50ms");
			await vi.advanceTimersByTimeAsync(60);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});

	test("does not discard the workspace when the hydration marker read fails", async () => {
		vi.useFakeTimers();
		try {
			const fs = fakeState({ "/.emdash-bot/hydrated": "main", "/repo/src/a.ts": "edited" });
			fs.hangReads();
			const hydrate = vi.fn(noHydrate);
			const env = makeEnv({
				state: fs.state,
				hydrateRepo: hydrate,
				deadlines: { defaultTimeoutMs: 50, attachTimeoutMs: 100, execGraceMs: 5 },
			});
			const pending = env.ensureRepo({ dir: "/repo", ref: "main" });
			const assertion = expect(pending).rejects.toThrow("VFS readFile timed out after 50ms");
			await vi.advanceTimersByTimeAsync(60);
			await assertion;
			expect(hydrate).not.toHaveBeenCalled();
			expect(fs.files.get("/repo/src/a.ts")).toBe("edited");
		} finally {
			vi.useRealTimers();
		}
	});

	test("rejects a corrupt change log instead of executing without VFS edits", async () => {
		const fs = fakeState({
			"/.emdash-bot/changes.json": "not-json",
			"/repo/src/a.ts": "edited",
		});
		const con = fakeContainer();
		const env = makeEnv({ state: fs.state, container: con.container });

		await expect(env.exec("pnpm test")).rejects.toThrow("invalid VFS change log");
		expect(con.execs).toEqual([]);
	});

	test("rejects change-log paths outside the repository", async () => {
		const fs = fakeState({
			"/.emdash-bot/changes.json": JSON.stringify(["/tmp/escape"]),
			"/tmp/escape": "content",
		});
		const con = fakeContainer();
		const env = makeEnv({ state: fs.state, container: con.container });

		await expect(env.exec("pnpm test")).rejects.toThrow("path outside repository");
		expect(con.execs).toEqual([]);
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
