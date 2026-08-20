import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

import { type ContainerBackend, ExecEnv, type IsolateState } from "../../.flue/lib/exec-env.js";

const execFileAsync = promisify(execFile);

describe("candidate git publication", () => {
	test("pushes the durable workspace with a lease and reuses the published run", async () => {
		const root = await mkdtemp(join(tmpdir(), "emdash-publish-"));
		const remote = join(root, "remote.git");
		const repo = join(root, "repo");
		try {
			await git(root, "init", "--bare", remote);
			await mkdir(repo);
			await git(repo, "init");
			await git(repo, "config", "user.email", "emdashbot@example.test");
			await git(repo, "config", "user.name", "EmDashBot");
			await writeFile(join(repo, "README.md"), "base\n");
			await git(repo, "add", "README.md");
			await git(repo, "commit", "-m", "Base");
			await git(repo, "remote", "add", "origin", remote);
			const baseRef = (await git(repo, "rev-parse", "HEAD")).trim();
			const env = new ExecEnv({
				state: memoryState(),
				attachContainer: async () => localContainer(),
				hydrateRepo: async () => {},
				deadlines: { defaultTimeoutMs: 30_000, attachTimeoutMs: 30_000, execGraceMs: 1_000 },
				repoDir: repo,
			});
			await env.writeFile(join(repo, "src/base-url.ts"), "export const base = '/field-notes';\n");

			const input = {
				branch: "bot/fix-42",
				runId: "run-42",
				commitMessage: "Fix base URLs",
				baseRef,
				expectedPreviousSha: null,
			};
			const published = await env.publishCandidate(input);
			const repeated = await env.publishCandidate(input);

			expect(repeated).toEqual(published);
			expect(
				await git(root, `--git-dir=${remote}`, "show", "refs/heads/bot/fix-42:src/base-url.ts"),
			).toBe("export const base = '/field-notes';\n");
			expect(
				await git(root, `--git-dir=${remote}`, "show", "-s", "--format=%B", published.commitSha),
			).toContain("EmDash-Run: run-42");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});

function memoryState(): IsolateState {
	const files = new Map<string, string>();
	return {
		readFile: async (path) => {
			const value = files.get(path);
			if (value === undefined) throw new Error(`missing VFS file: ${path}`);
			return value;
		},
		writeFile: async (path, content) => {
			files.set(path, content);
		},
		mkdir: async () => {},
		readdirWithFileTypes: async () => [],
		exists: async (path) => files.has(path),
		rm: async (path) => {
			files.delete(path);
		},
		searchFiles: async () => [],
	};
}

function localContainer(): ContainerBackend {
	return {
		isReady: async () => true,
		exec: async (command, options) => {
			try {
				const result = await execFileAsync("bash", ["-c", command], {
					cwd: options?.cwd,
					timeout: options?.timeoutMs,
					encoding: "utf8",
				});
				return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
			} catch (error) {
				const failure = error as { code?: number; stdout?: string; stderr?: string };
				return {
					exitCode: typeof failure.code === "number" ? failure.code : 1,
					stdout: failure.stdout ?? "",
					stderr: failure.stderr ?? "",
				};
			}
		},
		writeFile: async (path, content) => {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content);
		},
		readFileBytes: async (path) => new Uint8Array(await readFile(path)),
	};
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
	return result.stdout;
}
