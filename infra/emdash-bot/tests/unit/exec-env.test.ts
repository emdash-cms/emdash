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

function fakeIsolate(overrides: Partial<IsolateBackend["fs"]> = {}): {
	isolate: IsolateBackend;
	execs: RecordedExec[];
	files: Map<string, string>;
	setExecResult: (result: { exitCode: number; stdout: string; stderr: string }) => void;
	hangExec: () => void;
} {
	const execs: RecordedExec[] = [];
	const files = new Map<string, string>();
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
		git: { clone: async () => {} },
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

	test("container exec routes to the container substrate, not the isolate", async () => {
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
		expect(iso.execs).toHaveLength(0);
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

describe("ExecEnv edit bridge", () => {
	test("edits made before attach are replayed into the container checkout", async () => {
		const iso = fakeIsolate();
		iso.files.set("/repo/src/x.ts", "old body");
		const con = fakeContainer();
		const env = new ExecEnv({
			isolate: iso.isolate,
			attachContainer: async () => con.container,
			deadlines,
			repoDir: "/repo",
		});

		await env.edit("/repo/src/x.ts", "old", "new");
		expect(iso.files.get("/repo/src/x.ts")).toBe("new body");
		expect(con.writes).toHaveLength(0);

		await env.exec("pnpm test", { target: "container" });
		expect(con.writes).toEqual([{ path: "/repo/src/x.ts", content: "new body" }]);
	});

	test("edits made after attach are written through immediately", async () => {
		const iso = fakeIsolate();
		iso.files.set("/repo/src/y.ts", "a");
		const con = fakeContainer();
		const env = new ExecEnv({
			isolate: iso.isolate,
			attachContainer: async () => con.container,
			deadlines,
			repoDir: "/repo",
		});

		await env.exec("pnpm install", { target: "container" });
		await env.writeFile("/repo/src/y.ts", "b");

		expect(con.writes).toEqual([{ path: "/repo/src/y.ts", content: "b" }]);
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
	test("readArtifact reads bytes from the container substrate", async () => {
		const iso = fakeIsolate();
		const con = fakeContainer();
		const attach = vi.fn(async () => con.container);
		const env = new ExecEnv({
			isolate: iso.isolate,
			attachContainer: attach,
			deadlines,
			repoDir: "/repo",
		});

		const bytes = await env.readArtifact("/repo/.bot-artifacts/step-1.png");

		expect([...bytes]).toEqual([1, 2, 3]);
		expect(attach).toHaveBeenCalledTimes(1);
	});
});

describe("ExecEnv clone", () => {
	test("cloneRepo forwards the auth header to the VFS clone", async () => {
		const clone = vi.fn(async () => {});
		const iso = fakeIsolate();
		const env = new ExecEnv({
			isolate: { ...iso.isolate, git: { clone } },
			attachContainer: async () => fakeContainer().container,
			deadlines,
			repoDir: "/repo",
		});

		await env.cloneRepo({
			url: "https://github.com/emdash-cms/emdash.git",
			dir: "/repo",
			ref: "main",
			depth: 50,
			authHeader: "Basic xyz",
		});

		expect(clone).toHaveBeenCalledWith({
			url: "https://github.com/emdash-cms/emdash.git",
			dir: "/repo",
			ref: "main",
			depth: 50,
			headers: { Authorization: "Basic xyz" },
		});
	});
});

beforeEach(() => {
	vi.clearAllMocks();
});
