import { beforeEach, describe, expect, test, vi } from "vitest";

import {
	type ContainerBackend,
	ExecEnv,
	type IsolateBackend,
	ISOLATE_SHELL_BACKEND,
} from "../../.flue/lib/exec-env.js";

interface RecordedExec {
	source: string;
	options: { backend?: string; cwd?: string; encoding: "utf8"; timeoutMs?: number };
}

const GIT_STATUS = "git status --porcelain -z --untracked-files=all";

function fakeIsolate(
	overrides: Partial<IsolateBackend["fs"]> = {},
	sharedFiles?: Map<string, string>,
): {
	isolate: IsolateBackend;
	execs: RecordedExec[];
	files: Map<string, string>;
	setExecResult: (result: { exitCode: number; stdout: string; stderr: string }) => void;
	hangExec: () => void;
} {
	const execs: RecordedExec[] = [];
	const files = sharedFiles ?? new Map<string, string>();
	let execResult = { exitCode: 0, stdout: "", stderr: "" };
	let hang = false;
	const isolate: IsolateBackend = {
		fs: {
			readFile: async (path) => {
				const value = files.get(path);
				if (value === undefined) throw new Error(`no such file ${path}`);
				return value;
			},
			writeFile: async (path, content) => {
				files.set(path, content);
			},
			mkdir: async () => {},
			readdir: async () => [{ name: "a.ts", isDirectory: false }],
			rm: async () => {},
			grep: async () => [{ path: "/repo/a.ts", line: 3, text: "TODO" }],
			...overrides,
		},
		runtime: {
			exec: async (source, options) => {
				execs.push({ source, options });
				if (hang) return { result: () => new Promise<never>(() => {}) };
				return { result: async () => execResult, [Symbol.dispose]: () => {} };
			},
		},
	};
	return {
		isolate,
		execs,
		files,
		setExecResult: (result) => {
			execResult = result;
		},
		hangExec: () => {
			hang = true;
		},
	};
}

function fakeContainer(): {
	container: ContainerBackend;
	execs: string[];
	writes: Array<{ path: string; content: string }>;
} {
	const execs: string[] = [];
	const writes: Array<{ path: string; content: string }> = [];
	const container: ContainerBackend = {
		exec: async (command) => {
			execs.push(command);
			return { exitCode: 0, stdout: "container-ran", stderr: "" };
		},
		writeFile: async (path, content) => {
			writes.push({ path, content });
		},
		readFileBytes: async () => new Uint8Array([1, 2, 3]),
	};
	return { container, execs, writes };
}

const deadlines = { defaultTimeoutMs: 10_000, execGraceMs: 500 };

describe("ExecEnv exec routing", () => {
	test("isolate exec runs on the worker-shell backend and normalizes the handle result", async () => {
		const iso = fakeIsolate();
		iso.setExecResult({ exitCode: 2, stdout: "hits", stderr: "warn" });
		const attach = vi.fn(async () => fakeContainer().container);
		const env = new ExecEnv({
			isolate: iso.isolate,
			attachContainer: attach,
			deadlines,
			repoDir: "/repo",
		});

		const result = await env.exec("grep -r TODO", { target: "isolate", cwd: "/repo" });

		expect(result).toEqual({ exitCode: 2, stdout: "hits", stderr: "warn" });
		expect(iso.execs).toHaveLength(1);
		expect(iso.execs[0]?.options.backend).toBe(ISOLATE_SHELL_BACKEND);
		expect(iso.execs[0]?.options.encoding).toBe("utf8");
		expect(iso.execs[0]?.options.cwd).toBe("/repo");
		expect(attach).not.toHaveBeenCalled();
	});

	test("container exec runs the command on the container; the isolate only runs the sync probe", async () => {
		const iso = fakeIsolate();
		const con = fakeContainer();
		const env = new ExecEnv({
			isolate: iso.isolate,
			attachContainer: async () => con.container,
			deadlines,
			repoDir: "/repo",
		});

		const result = await env.exec("pnpm install", { target: "container" });

		expect(result.stdout).toBe("container-ran");
		expect(con.execs).toEqual(["pnpm install"]);
		expect(iso.execs.map((e) => e.source)).toEqual([GIT_STATUS]);
	});
});

describe("ExecEnv deadlines", () => {
	test("a hung isolate exec rejects with the labelled deadline error", async () => {
		vi.useFakeTimers();
		try {
			const iso = fakeIsolate();
			iso.hangExec();
			const env = new ExecEnv({
				isolate: iso.isolate,
				attachContainer: async () => fakeContainer().container,
				deadlines: { defaultTimeoutMs: 50, execGraceMs: 5 },
				repoDir: "/repo",
			});
			const pending = env.exec("sleep 999", { target: "isolate", timeoutMs: 20 });
			const assertion = expect(pending).rejects.toThrow("isolate exec timed out after 25ms");
			await vi.advanceTimersByTimeAsync(30);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});

	test("container exec adds the grace margin to its own timeout", async () => {
		vi.useFakeTimers();
		try {
			const iso = fakeIsolate();
			const env = new ExecEnv({
				isolate: iso.isolate,
				attachContainer: async () => ({
					exec: () => new Promise<never>(() => {}),
					writeFile: async () => {},
					readFileBytes: async () => new Uint8Array(),
				}),
				deadlines: { defaultTimeoutMs: 1_000, execGraceMs: 5 },
				repoDir: "/repo",
			});
			const pending = env.exec("vitest", { target: "container", timeoutMs: 10 });
			const assertion = expect(pending).rejects.toThrow("container exec timed out after 15ms");
			await vi.advanceTimersByTimeAsync(20);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("ExecEnv container lifecycle", () => {
	test("the container is attached lazily and reused across execs", async () => {
		const iso = fakeIsolate();
		const con = fakeContainer();
		const attach = vi.fn(async () => con.container);
		const env = new ExecEnv({
			isolate: iso.isolate,
			attachContainer: attach,
			deadlines,
			repoDir: "/repo",
		});

		expect(attach).not.toHaveBeenCalled();
		await env.exec("pnpm install", { target: "container" });
		await env.exec("pnpm test", { target: "container" });

		expect(attach).toHaveBeenCalledTimes(1);
		expect(con.execs).toEqual(["pnpm install", "pnpm test"]);
	});
});

describe("ExecEnv VFS->container materialization", () => {
	test("materializes the current VFS content of paths git reports, not a memory snapshot", async () => {
		const iso = fakeIsolate();
		iso.files.set("/repo/src/x.ts", "v1");
		const con = fakeContainer();
		const env = new ExecEnv({
			isolate: iso.isolate,
			attachContainer: async () => con.container,
			deadlines,
			repoDir: "/repo",
		});

		await env.edit("/repo/src/x.ts", "v1", "v2");
		iso.setExecResult({ exitCode: 0, stdout: " M src/x.ts\0", stderr: "" });

		await env.exec("pnpm test", { target: "container" });

		expect(con.writes).toEqual([{ path: "/repo/src/x.ts", content: "v2" }]);
	});

	test("an edit in one instance is materialized when another attaches over the same VFS", async () => {
		const files = new Map<string, string>([["/repo/src/x.ts", "old"]]);
		const con = fakeContainer();
		const envA = new ExecEnv({
			isolate: fakeIsolate({}, files).isolate,
			attachContainer: async () => con.container,
			deadlines,
			repoDir: "/repo",
		});
		await envA.edit("/repo/src/x.ts", "old", "new");

		const isoB = fakeIsolate({}, files);
		isoB.setExecResult({ exitCode: 0, stdout: " M src/x.ts\0", stderr: "" });
		const envB = new ExecEnv({
			isolate: isoB.isolate,
			attachContainer: async () => con.container,
			deadlines,
			repoDir: "/repo",
		});

		await envB.exec("pnpm test", { target: "container" });

		expect(con.writes).toEqual([{ path: "/repo/src/x.ts", content: "new" }]);
	});

	test("an edit after attach lands on a fresh instance's re-attach, past the reset", async () => {
		const files = new Map<string, string>([["/repo/src/y.ts", "base"]]);
		const con = fakeContainer();
		const isoA = fakeIsolate({}, files);
		const envA = new ExecEnv({
			isolate: isoA.isolate,
			attachContainer: async () => con.container,
			deadlines,
			repoDir: "/repo",
		});
		await envA.exec("pnpm install", { target: "container" });
		await envA.writeFile("/repo/src/y.ts", "fixed");
		expect(con.writes).toHaveLength(0);

		const isoB = fakeIsolate({}, files);
		isoB.setExecResult({ exitCode: 0, stdout: " M src/y.ts\0", stderr: "" });
		const attachB = vi.fn(async () => con.container);
		const envB = new ExecEnv({
			isolate: isoB.isolate,
			attachContainer: attachB,
			deadlines,
			repoDir: "/repo",
		});

		await envB.exec("pnpm test", { target: "container" });

		expect(attachB).toHaveBeenCalledTimes(1);
		expect(con.writes).toEqual([{ path: "/repo/src/y.ts", content: "fixed" }]);
	});

	test("a git-reported deletion is removed from the container", async () => {
		const iso = fakeIsolate();
		iso.setExecResult({ exitCode: 0, stdout: " D src/gone.ts\0", stderr: "" });
		const con = fakeContainer();
		const env = new ExecEnv({
			isolate: iso.isolate,
			attachContainer: async () => con.container,
			deadlines,
			repoDir: "/repo",
		});

		await env.exec("pnpm test", { target: "container" });

		expect(con.execs).toEqual(["rm -f -- '/repo/src/gone.ts'", "pnpm test"]);
		expect(con.writes).toHaveLength(0);
	});

	test("a rename deletes the old path and materializes the new (-z new-then-old order)", async () => {
		const iso = fakeIsolate();
		iso.files.set("/repo/src/new.ts", "moved");
		iso.setExecResult({ exitCode: 0, stdout: "R  src/new.ts\0src/old.ts\0", stderr: "" });
		const con = fakeContainer();
		const env = new ExecEnv({
			isolate: iso.isolate,
			attachContainer: async () => con.container,
			deadlines,
			repoDir: "/repo",
		});

		await env.exec("pnpm test", { target: "container" });

		expect(con.execs).toEqual(["rm -f -- '/repo/src/old.ts'", "pnpm test"]);
		expect(con.writes).toEqual([{ path: "/repo/src/new.ts", content: "moved" }]);
	});

	test("a non-ASCII path is materialized verbatim (-z carries it unescaped)", async () => {
		const iso = fakeIsolate();
		iso.files.set("/repo/café.ts", "☕");
		iso.setExecResult({ exitCode: 0, stdout: " M café.ts\0", stderr: "" });
		const con = fakeContainer();
		const env = new ExecEnv({
			isolate: iso.isolate,
			attachContainer: async () => con.container,
			deadlines,
			repoDir: "/repo",
		});

		await env.exec("pnpm test", { target: "container" });

		expect(con.writes).toEqual([{ path: "/repo/café.ts", content: "☕" }]);
	});

	test("edit throws when the target is absent or ambiguous", async () => {
		const iso = fakeIsolate();
		iso.files.set("/repo/dup.ts", "x x");
		const env = new ExecEnv({
			isolate: iso.isolate,
			attachContainer: async () => fakeContainer().container,
			deadlines,
			repoDir: "/repo",
		});

		await expect(env.edit("/repo/dup.ts", "y", "z")).rejects.toThrow("not found");
		await expect(env.edit("/repo/dup.ts", "x", "z")).rejects.toThrow("not unique");
	});
});

describe("ExecEnv artifact egress", () => {
	test("reads a bare artifact name from under .bot-artifacts", async () => {
		const con = fakeContainer();
		const env = new ExecEnv({
			isolate: fakeIsolate().isolate,
			attachContainer: async () => con.container,
			deadlines,
			repoDir: "/repo",
		});

		const bytes = await env.readArtifact("step-1.png");

		expect([...bytes]).toEqual([1, 2, 3]);
		expect(con.execs[0]).toContain("/repo/.bot-artifacts/step-1.png");
	});

	test("rejects any name that could escape the artifacts directory", async () => {
		const attach = vi.fn(async () => fakeContainer().container);
		const env = new ExecEnv({
			isolate: fakeIsolate().isolate,
			attachContainer: attach,
			deadlines,
			repoDir: "/repo",
		});

		for (const bad of ["../secrets", "a/b.png", "/etc/passwd", "..", ".", "", "a\\b"]) {
			await expect(env.readArtifact(bad)).rejects.toThrow("invalid artifact name");
		}
		expect(attach).not.toHaveBeenCalled();
	});

	test("refuses a symlinked artifact", async () => {
		const container: ContainerBackend = {
			exec: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
			writeFile: async () => {},
			readFileBytes: async () => new Uint8Array([9]),
		};
		const env = new ExecEnv({
			isolate: fakeIsolate().isolate,
			attachContainer: async () => container,
			deadlines,
			repoDir: "/repo",
		});

		await expect(env.readArtifact("evil.png")).rejects.toThrow("not a regular file");
	});
});

describe("ExecEnv clone", () => {
	const emptyVfs = {
		readdir: async (path: string): Promise<Array<{ name: string; isDirectory: boolean }>> => {
			throw new Error(`no such directory ${path}`);
		},
	};

	test("cloneRepo runs a shallow isolate git clone of the public repo", async () => {
		const iso = fakeIsolate(emptyVfs);
		const env = new ExecEnv({
			isolate: iso.isolate,
			attachContainer: async () => fakeContainer().container,
			deadlines,
			repoDir: "/repo",
		});

		await env.cloneRepo({
			url: "https://github.com/emdash-cms/emdash.git",
			dir: "/workspace/repo",
			ref: "main",
			depth: 50,
		});

		expect(iso.execs).toHaveLength(1);
		expect(iso.execs[0]?.source).toBe(
			"git clone --depth 50 --branch main 'https://github.com/emdash-cms/emdash.git' '/workspace/repo'",
		);
		expect(iso.execs[0]?.options.backend).toBe(ISOLATE_SHELL_BACKEND);
	});

	test("cloneRepo skips the clone when the durable VFS already holds a usable one", async () => {
		const iso = fakeIsolate({
			readdir: async () => [{ name: "HEAD", isDirectory: false }],
		});
		const env = new ExecEnv({
			isolate: iso.isolate,
			attachContainer: async () => fakeContainer().container,
			deadlines,
			repoDir: "/repo",
		});

		await env.cloneRepo({
			url: "https://github.com/emdash-cms/emdash.git",
			dir: "/workspace/repo",
		});

		expect(iso.execs.map((e) => e.source)).toEqual(["git status --porcelain"]);
		expect(iso.execs[0]?.options.cwd).toBe("/workspace/repo");
	});

	test("cloneRepo discards an unusable partial clone and re-clones", async () => {
		const removed: string[] = [];
		const iso = fakeIsolate({
			readdir: async () => [{ name: "HEAD", isDirectory: false }],
			rm: async (path) => {
				removed.push(path);
			},
		});
		iso.setExecResult({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository" });
		const env = new ExecEnv({
			isolate: iso.isolate,
			attachContainer: async () => fakeContainer().container,
			deadlines,
			repoDir: "/repo",
		});

		await expect(
			env.cloneRepo({ url: "https://github.com/x/y.git", dir: "/workspace/repo" }),
		).rejects.toThrow("git clone failed (128)");
		expect(removed).toEqual(["/workspace/repo"]);
		expect(iso.execs.map((e) => e.source)).toEqual([
			"git status --porcelain",
			"git clone --depth 50 'https://github.com/x/y.git' '/workspace/repo'",
		]);
	});

	test("cloneRepo throws when the clone exits non-zero", async () => {
		const iso = fakeIsolate(emptyVfs);
		iso.setExecResult({ exitCode: 128, stdout: "", stderr: "fatal: repository not found" });
		const env = new ExecEnv({
			isolate: iso.isolate,
			attachContainer: async () => fakeContainer().container,
			deadlines,
			repoDir: "/repo",
		});

		await expect(
			env.cloneRepo({ url: "https://github.com/x/y.git", dir: "/workspace/repo" }),
		).rejects.toThrow("git clone failed (128)");
	});
});

beforeEach(() => {
	vi.clearAllMocks();
});
