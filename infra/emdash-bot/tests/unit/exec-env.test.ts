import { describe, expect, test, vi } from "vitest";

import { type ContainerBackend, ExecEnv, type IsolateState } from "../../.flue/lib/exec-env.js";

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
	hangExec: () => void;
} {
	const execs: string[] = [];
	const writes: Array<{ path: string; content: string }> = [];
	let execResult = { exitCode: 0, stdout: "container-ran", stderr: "" };
	let hang = false;
	const container: ContainerBackend = {
		exec: async (command) => {
			execs.push(command);
			if (hang) return new Promise<never>(() => {});
			return execResult;
		},
		writeFile: async (path, content) => {
			writes.push({ path, content });
		},
		readFileBytes: async () => new Uint8Array([1, 2, 3]),
	};
	return {
		container,
		execs,
		writes,
		setExecResult: (result) => {
			execResult = result;
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
		expect(con.execs).toEqual(["pnpm test"]);
	});

	test("materializes logged VFS edits before the command runs", async () => {
		const fs = fakeState({ "/repo/src/x.ts": "v1" });
		const con = fakeContainer();
		const env = makeEnv({ state: fs.state, container: con.container });

		await env.writeFile("/repo/src/x.ts", "v2");
		await env.exec("pnpm test");

		expect(con.writes).toEqual([{ path: "/repo/src/x.ts", content: "v2" }]);
		expect(con.execs).toEqual(["pnpm test"]);
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
		expect(con.execs).toEqual(["pnpm install", "pnpm test"]);
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
