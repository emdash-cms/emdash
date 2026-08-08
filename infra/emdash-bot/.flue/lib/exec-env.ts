// execEnv: the single seam over the investigation's execution substrates.
//
// Hybrid substrate model (decided in slice 3):
//   - Isolate + VFS + git: @cloudflare/computer 0.1.1 `Workspace`. Owns the
//     repo clone, all reads/greps/git inspection, and the authoritative copy
//     of agent edits. This is the >90% path and never starts a container.
//   - Container: @cloudflare/sandbox. Owns the toolchain -- pnpm install,
//     astro build, vitest, agent-browser -- because computer's own container
//     backend needs a `computerd` image that is not published to npm and must
//     be built from the cloudflare/computer monorepo (unshippable here).
//
// THE FLIP-POINT. When Cloudflare publishes `@cloudflare/computerd` (or a
// pullable image), the container substrate becomes computer's
// CloudflareContainerBackend routed by `runtime.exec(cmd, { backend })`, and
// `fromSandbox` / the `ContainerBackend` adapter is the only code that
// changes -- the ExecEnv surface and its callers stay put. Every
// @cloudflare/computer and @cloudflare/sandbox touchpoint is confined to this
// file for exactly that reason.
//
// Filesystem coherence (the hybrid's one real seam). The VFS and the
// container are separate filesystems, so edits made against the VFS are not
// visible to a container test run on their own. ExecEnv bridges them: every
// write/edit is recorded and, once a container is attached, replayed into the
// container checkout, and any write after attach is written through
// immediately. The isolate reads stay VFS-only (fast, no container).
//
// Q(a) agent-browser <-> dev server: both run inside the one attached
// container and share its localhost (e.g. :4321), exactly as the gen-1
// sandbox did -- there is no cross-substrate networking to arrange.
// Q(b) artifact egress: agent-browser writes screenshots into the container
// FS (`.bot-artifacts/`); `readArtifact` reads them back from the container
// substrate for the orchestrator to attach. (Under a future pure-computer
// setup this becomes a `workspace.fs` read after the VFS sync.)
// Q(c) GitHub reads: emdash is a public repo, so the VFS read-clone needs no
// credential at all -- it runs through the DO's in-VFS isomorphic-git (the
// worker-shell `git` command forwards to the host), so no token reaches the
// isolate. The container keeps the existing outbound proxy, so the only place
// a token is minted (the fix push) still never exposes it to the sandbox.

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
	/** Repo-relative paths edited in the VFS but not yet in the container. */
	readonly #dirtyPaths = new Set<string>();

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
		const args = ["git", "clone", "--depth", String(options.depth ?? 50)];
		if (options.ref) args.push("--branch", options.ref);
		args.push(quote(options.url), quote(options.dir));
		const result = await this.exec(args.join(" "), { target: "isolate" });
		if (result.exitCode !== 0) {
			throw new Error(`git clone failed (${result.exitCode}): ${result.stderr.slice(-500)}`);
		}
	}

	readFile(path: string): Promise<string> {
		return this.#bounded(this.#isolate.fs.readFile(path, "utf8"), "readFile");
	}

	async writeFile(path: string, content: string): Promise<void> {
		await this.#bounded(this.#isolate.fs.writeFile(path, content), "writeFile");
		await this.#recordEdit(path, content);
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
		return withDeadline(
			container.exec(command, { cwd, ...(timeoutMs ? { timeoutMs } : {}) }),
			deadlineMs,
			"container exec",
		);
	}

	/**
	 * Attach the container (once) and bring its checkout up to date with any
	 * VFS edits made before attach. Reused across execs for the run's life.
	 */
	container(): Promise<ContainerBackend> {
		if (!this.#containerPromise) {
			this.#containerPromise = this.#attachContainer().then(async (container) => {
				await this.#replayDirtyPaths(container);
				return container;
			});
		}
		return this.#containerPromise;
	}

	/** Read a container-produced artifact (screenshots) for egress (Q(b)). */
	async readArtifact(path: string): Promise<Uint8Array> {
		const container = await this.container();
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

	async #recordEdit(path: string, content: string): Promise<void> {
		if (this.#containerPromise) {
			const container = await this.#containerPromise;
			await this.#bounded(container.writeFile(path, content), "container writeFile");
			return;
		}
		this.#dirtyPaths.add(path);
	}

	async #replayDirtyPaths(container: ContainerBackend): Promise<void> {
		for (const path of this.#dirtyPaths) {
			const content = await this.#bounded(this.#isolate.fs.readFile(path, "utf8"), "readFile");
			await this.#bounded(container.writeFile(path, content), "container writeFile");
		}
		this.#dirtyPaths.clear();
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
