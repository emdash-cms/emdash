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

	test("preserves shell-created symlinks and executable modes through publication", async () => {
		const root = await mkdtemp(join(tmpdir(), "emdash-publish-mode-"));
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
			await env.ensureRepo({ dir: repo, ref: baseRef });

			await env.execWritable("chmod +x README.md && ln -s README.md readme-link");
			await env.publishCandidate({
				branch: "bot/fix-43",
				runId: "run-43",
				commitMessage: "Preserve repository metadata",
				baseRef,
				expectedPreviousSha: null,
			});

			const tree = await git(
				root,
				`--git-dir=${remote}`,
				"ls-tree",
				"refs/heads/bot/fix-43",
				"README.md",
				"readme-link",
			);
			expect(tree).toContain("100755 blob");
			expect(tree).toContain("120000 blob");
			expect(
				await git(root, `--git-dir=${remote}`, "show", "refs/heads/bot/fix-43:readme-link"),
			).toBe("README.md");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);

	test("publishes selected artifacts on the isolated artifact branch", async () => {
		const root = await mkdtemp(join(tmpdir(), "emdash-publish-artifact-"));
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
			await mkdir(join(repo, ".bot-artifacts"));
			await writeFile(join(repo, ".bot-artifacts", "result.png"), "image-bytes");
			const env = new ExecEnv({
				state: memoryState(),
				attachContainer: async () => localContainer(),
				hydrateRepo: async () => {},
				deadlines: { defaultTimeoutMs: 30_000, attachTimeoutMs: 30_000, execGraceMs: 1_000 },
				repoDir: repo,
			});

			await expect(
				env.publishArtifacts({
					branch: "bot/artifacts-44",
					runId: "run-44",
					baseRef,
					files: ["result.png"],
				}),
			).resolves.toEqual({ branch: "bot/artifacts-44", files: ["result.png"] });

			expect(
				await git(
					root,
					`--git-dir=${remote}`,
					"show",
					"refs/heads/bot/artifacts-44:.bot-artifacts/result.png",
				),
			).toBe("image-bytes");
			const tree = await git(root, `--git-dir=${remote}`, "ls-tree", "refs/heads/bot/artifacts-44");
			expect(tree).toContain(".bot-artifacts");
			expect(tree).not.toContain("README.md");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});

function memoryState(): IsolateState {
	const files = new Map<string, string>();
	const symlinks = new Map<string, string>();
	return {
		readFile: async (path) => {
			const value = files.get(path);
			if (value === undefined) throw new Error(`missing VFS file: ${path}`);
			return value;
		},
		readFileBytes: async (path) => {
			const value = files.get(path);
			if (value === undefined) throw new Error(`missing VFS file: ${path}`);
			return new TextEncoder().encode(value);
		},
		writeFile: async (path, content) => {
			symlinks.delete(path);
			files.set(path, content);
		},
		writeFileBytes: async (path, content) => {
			symlinks.delete(path);
			files.set(path, new TextDecoder().decode(content));
		},
		lstat: async (path) => {
			if (symlinks.has(path)) return { type: "symlink" };
			if (files.has(path)) return { type: "file" };
			return null;
		},
		symlink: async (target, linkPath) => {
			files.delete(linkPath);
			symlinks.set(linkPath, target);
		},
		readlink: async (path) => {
			const target = symlinks.get(path);
			if (target === undefined) throw new Error(`not a symlink: ${path}`);
			return target;
		},
		mkdir: async () => {},
		readdirWithFileTypes: async () => [],
		exists: async (path) => files.has(path) || symlinks.has(path),
		rm: async (path) => {
			files.delete(path);
			symlinks.delete(path);
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
