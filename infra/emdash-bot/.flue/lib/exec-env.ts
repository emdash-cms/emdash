// execEnv: the single seam over the investigation's two execution substrates.
// Every @cloudflare/computer and @cloudflare/sandbox touchpoint lives here.
//
//   - Isolate + VFS: @cloudflare/computer `Workspace` (fs + worker-shell
//     exec). Holds the repo clone and every agent edit. Reads/greps/git run
//     here without a container.
//   - Container: @cloudflare/sandbox. Runs the toolchain (pnpm, astro, vitest,
//     agent-browser).
//
// The VFS is authoritative for source: before every container exec, the
// container's working tree is re-synced from the VFS via `git status` against
// the checkout -- never from in-memory bookkeeping -- so an edit is
// materialized whether it was made before or after the container attached,
// and in this isolate or a resumed one. Container-only files (node_modules,
// build output) are untracked in the VFS and never touched. The one-time
// `git reset` that seeds the container checkout is owned by the injected
// `attachContainer`, which runs once.
//
// The VFS clone is unauthenticated; token minting is confined to the
// container's fix-push through the proxy.

import type { WorkspaceClient } from "@cloudflare/computer";
import type { Sandbox } from "@cloudflare/sandbox";

import { withDeadline } from "./sandbox-deadline.js";

export type ExecTarget = "isolate" | "container";

export interface ExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface ExecOptions {
	readonly target: ExecTarget;
	readonly cwd?: string;
	readonly timeoutMs?: number;
}

export interface GrepMatch {
	readonly path: string;
	readonly line: number;
	readonly text: string;
}

export interface CloneOptions {
	readonly url: string;
	readonly dir: string;
	readonly ref?: string;
	readonly depth?: number;
}

export interface ExecEnvDeadlines {
	/** Ceiling for fs/git RPCs and for an exec with no explicit timeout. */
	readonly defaultTimeoutMs: number;
	/** Added to an exec's own timeout so the substrate kills before we do. */
	readonly execGraceMs: number;
}

/**
 * Isolate + VFS substrate. A structural subset of computer's `getWorkspace()`
 * client (`fs` + `runtime` reach the DO over RPC through their stubs);
 * `fromWorkspaceClient` adapts the real client, tests pass a fake.
 */
export interface IsolateBackend {
	readonly fs: {
		readFile(path: string, encoding: "utf8"): Promise<string>;
		writeFile(path: string, content: string): Promise<void>;
		mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
		readdir(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
		rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
		grep(pattern: string, path: string, options?: { ignoreCase?: boolean }): Promise<GrepMatch[]>;
	};
	readonly runtime: {
		exec(
			source: string,
			options: { backend?: string; cwd?: string; encoding: "utf8"; timeoutMs?: number },
		): Promise<IsolateExecHandle>;
	};
}

/** Minimal view of computer's `WorkspaceRuntimeExecHandle`. */
export interface IsolateExecHandle {
	result(): Promise<{ exitCode: number; stdout: string; stderr: string }>;
	[Symbol.dispose]?(): void;
}

/**
 * Container substrate. A structural subset of @cloudflare/sandbox's session;
 * `fromSandbox` adapts the real sandbox, tests pass a fake.
 */
export interface ContainerBackend {
	exec(
		command: string,
		options?: { cwd?: string; timeoutMs?: number },
	): Promise<{ exitCode: number; stdout: string; stderr: string }>;
	writeFile(path: string, content: string): Promise<void>;
	readFileBytes(path: string): Promise<Uint8Array>;
}

/** Backend id the isolate shell registers under (WorkerShellBackend). */
export const ISOLATE_SHELL_BACKEND = "worker-shell";

const PATH_SEPARATOR = /[/\\]/;

export interface ExecEnvOptions {
	readonly isolate: IsolateBackend;
	/** Lazily attaches the container; called at most once, result reused. */
	readonly attachContainer: () => Promise<ContainerBackend>;
	readonly deadlines: ExecEnvDeadlines;
	/** Working-tree root, shared by both substrates (e.g. /workspace/repo). */
	readonly repoDir: string;
}

export class ExecEnv {
	readonly #isolate: IsolateBackend;
	readonly #attachContainer: () => Promise<ContainerBackend>;
	readonly #deadlines: ExecEnvDeadlines;
	readonly #repoDir: string;
	#containerPromise: Promise<ContainerBackend> | undefined;

	constructor(options: ExecEnvOptions) {
		this.#isolate = options.isolate;
		this.#attachContainer = options.attachContainer;
		this.#deadlines = options.deadlines;
		this.#repoDir = options.repoDir;
	}

	/**
	 * Clone the repo into the VFS for isolate inspection and edit tracking.
	 * Runs through the worker-shell `git` command, which the DO's in-VFS
	 * isomorphic-git services -- no auth, since the repo is public.
	 */
	async cloneRepo(options: CloneOptions): Promise<void> {
		if (await this.#hasUsableClone(options.dir)) return;
		const args = ["git", "clone", "--depth", String(options.depth ?? 50)];
		if (options.ref) args.push("--branch", options.ref);
		args.push(quote(options.url), quote(options.dir));
		const result = await this.exec(args.join(" "), { target: "isolate" });
		if (result.exitCode !== 0) {
			throw new Error(`git clone failed (${result.exitCode}): ${result.stderr.slice(-500)}`);
		}
	}

	/**
	 * The durable VFS may hold a clone from an earlier attempt -- but only
	 * trust one git can actually read. A partial clone is removed so the
	 * caller re-clones.
	 */
	async #hasUsableClone(dir: string): Promise<boolean> {
		try {
			await this.#bounded(this.#isolate.fs.readdir(`${dir}/.git`), "readdir");
		} catch {
			return false;
		}
		const probe = await this.exec("git status --porcelain", { target: "isolate", cwd: dir });
		if (probe.exitCode === 0) return true;
		await this.#bounded(this.#isolate.fs.rm(dir, { recursive: true, force: true }), "rm");
		return false;
	}

	readFile(path: string): Promise<string> {
		return this.#bounded(this.#isolate.fs.readFile(path, "utf8"), "readFile");
	}

	writeFile(path: string, content: string): Promise<void> {
		return this.#bounded(this.#isolate.fs.writeFile(path, content), "writeFile");
	}

	/** Replace an exact substring; the file must contain it exactly once. */
	async edit(path: string, oldString: string, newString: string): Promise<void> {
		const current = await this.readFile(path);
		if (!current.includes(oldString)) throw new Error(`edit target not found in ${path}`);
		const first = current.indexOf(oldString);
		if (current.slice(first + oldString.length).includes(oldString)) {
			throw new Error(`edit target is not unique in ${path}`);
		}
		await this.writeFile(
			path,
			current.slice(0, first) + newString + current.slice(first + oldString.length),
		);
	}

	ls(path: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
		return this.#bounded(this.#isolate.fs.readdir(path), "readdir");
	}

	grep(pattern: string, path: string, options?: { ignoreCase?: boolean }): Promise<GrepMatch[]> {
		return this.#bounded(this.#isolate.fs.grep(pattern, path, options), "grep");
	}

	async exec(command: string, options: ExecOptions): Promise<ExecResult> {
		const timeoutMs = options.timeoutMs;
		const deadlineMs = timeoutMs
			? timeoutMs + this.#deadlines.execGraceMs
			: this.#deadlines.defaultTimeoutMs;
		const cwd = options.cwd ?? this.#repoDir;
		if (options.target === "isolate") {
			return this.#execIsolate(command, cwd, timeoutMs, deadlineMs);
		}
		const container = await this.container();
		await this.#materializeVfsChanges(container);
		return withDeadline(
			container.exec(command, { cwd, ...(timeoutMs ? { timeoutMs } : {}) }),
			deadlineMs,
			"container exec",
		);
	}

	/**
	 * Attach the container once and reuse it. Attach owns the one-time base
	 * checkout (via the injected `attachContainer`); working-tree sync is done
	 * per exec by `#materializeVfsChanges`, not here.
	 */
	container(): Promise<ContainerBackend> {
		return (this.#containerPromise ??= this.#attachContainer());
	}

	/**
	 * Read a container-produced artifact (a screenshot) for egress. `name` is a
	 * bare filename under `<repo>/.bot-artifacts/`; a path separator, `.`, `..`,
	 * or an absolute form is rejected and a symlink is refused, so a name can't
	 * escape the artifacts directory.
	 */
	async readArtifact(name: string): Promise<Uint8Array> {
		if (name === "" || name === "." || name === ".." || PATH_SEPARATOR.test(name)) {
			throw new Error(`invalid artifact name: ${name}`);
		}
		const path = `${this.#repoDir}/.bot-artifacts/${name}`;
		const container = await this.container();
		const check = await this.#bounded(
			container.exec(`test -f ${quote(path)} && test ! -L ${quote(path)}`),
			"readArtifact check",
		);
		if (check.exitCode !== 0) throw new Error(`artifact is not a regular file: ${name}`);
		return this.#bounded(container.readFileBytes(path), "readArtifact");
	}

	async #execIsolate(
		command: string,
		cwd: string,
		timeoutMs: number | undefined,
		deadlineMs: number,
	): Promise<ExecResult> {
		const handle = await withDeadline(
			this.#isolate.runtime.exec(command, {
				backend: ISOLATE_SHELL_BACKEND,
				encoding: "utf8",
				cwd,
				...(timeoutMs ? { timeoutMs } : {}),
			}),
			this.#deadlines.defaultTimeoutMs,
			"isolate exec start",
		);
		try {
			const result = await withDeadline(handle.result(), deadlineMs, "isolate exec");
			return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
		} finally {
			handle[Symbol.dispose]?.();
		}
	}

	/**
	 * Bring the container's working tree in line with the VFS. The change set is
	 * re-derived from the VFS on every call (`git status` against the checkout),
	 * so no edit is missed regardless of when or in which isolate it was made.
	 */
	async #materializeVfsChanges(container: ContainerBackend): Promise<void> {
		const status = await this.exec("git status --porcelain -z --untracked-files=all", {
			target: "isolate",
			cwd: this.#repoDir,
		});
		if (status.exitCode !== 0) {
			throw new Error(`git status failed (${status.exitCode}): ${status.stderr.slice(-500)}`);
		}
		for (const change of parsePorcelain(status.stdout)) {
			const path = `${this.#repoDir}/${change.path}`;
			if (change.op === "delete") {
				await this.#bounded(container.exec(`rm -f -- ${quote(path)}`), "materialize rm");
				continue;
			}
			const content = await this.#bounded(
				this.#isolate.fs.readFile(path, "utf8"),
				"materialize read",
			);
			await this.#bounded(container.writeFile(path, content), "materialize write");
		}
	}

	#bounded<T>(operation: Promise<T>, label: string): Promise<T> {
		return withDeadline(operation, this.#deadlines.defaultTimeoutMs, label);
	}
}

/**
 * Adapt the computer `getWorkspace()` client. The only structural computer
 * touchpoint. `fs` and `runtime` reach the DO over RPC through their stubs; the
 * seam therefore runs agent-side, not in the DO.
 */
export function fromWorkspaceClient(client: WorkspaceClient): IsolateBackend {
	return {
		fs: {
			readFile: (path, encoding) => client.fs.readFile(path, encoding),
			writeFile: (path, content) => client.fs.writeFile(path, content),
			mkdir: (path, options) => client.fs.mkdir(path, options),
			readdir: (path) => client.fs.readdir(path),
			rm: (path, options) => client.fs.rm(path, options),
			grep: (pattern, path, options) => client.fs.grep(pattern, path, options),
		},
		runtime: {
			exec: (source, options) => client.runtime.exec(source, options),
		},
	};
}

/** Single-quote a shell argument for the isolate command line. */
function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

interface VfsChange {
	readonly path: string;
	readonly op: "materialize" | "delete";
}

/**
 * Parse `git status --porcelain -z` into per-path sync ops. The `-z` format is
 * NUL-delimited and never quotes or C-escapes paths, so special characters and
 * spaces are carried verbatim. A rename/copy entry (`R`/`C`) is followed by a
 * second NUL field carrying the old path (new-path-then-old-path order): a
 * rename deletes the old path and materializes the new, a copy only
 * materializes. A `D` in either status column deletes; everything else
 * (modified, added, untracked) materializes.
 */
function parsePorcelain(output: string): VfsChange[] {
	const fields = output.split("\0");
	const changes: VfsChange[] = [];
	let i = 0;
	while (i < fields.length) {
		const field = fields[i];
		i += 1;
		if (field === undefined || field.length < 4) continue;
		const index = field[0];
		const worktree = field[1];
		const path = field.slice(3);
		if (index === "R" || index === "C" || worktree === "R" || worktree === "C") {
			const oldPath = fields[i];
			i += 1;
			if ((index === "R" || worktree === "R") && oldPath) {
				changes.push({ path: oldPath, op: "delete" });
			}
			changes.push({ path, op: "materialize" });
			continue;
		}
		const deleted = index === "D" || worktree === "D";
		changes.push({ path, op: deleted ? "delete" : "materialize" });
	}
	return changes;
}

/** Adapt the real sandbox. The only structural sandbox touchpoint. */
export function fromSandbox(sandbox: Sandbox): ContainerBackend {
	return {
		async exec(command, options) {
			const result = await sandbox.exec(command, {
				...(options?.cwd ? { cwd: options.cwd } : {}),
				...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
			});
			return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
		},
		async writeFile(path, content) {
			await sandbox.writeFile(path, content);
		},
		async readFileBytes(path) {
			const stream = await sandbox.readFileStream(path);
			return new Uint8Array(await new Response(stream).arrayBuffer());
		},
	};
}
