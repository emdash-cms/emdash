// execEnv: the single seam over the investigation's two execution substrates.
//
//   - Isolate + VFS: a @cloudflare/shell Workspace living in the agent DO's
//     own SQLite (large files spill to R2). Holds the hydrated repo tree and
//     every agent edit. Reads, searches, and edits run here with no container.
//   - Container: @cloudflare/sandbox. Runs the toolchain (git, pnpm, astro,
//     vitest, agent-browser) against its own native checkout.
//
// The VFS is authoritative for source. Every agent write goes through this
// seam and is recorded in a durable change log next to the workspace; before
// each container exec the logged paths are replayed onto the container
// checkout. Container-only files (node_modules, build output) are never
// touched. The one-time checkout that seeds the container is owned by the
// injected `attachContainer`, which runs once.

import type { Sandbox } from "@cloudflare/sandbox";

import { withDeadline } from "./sandbox-deadline.js";

export interface ExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface ExecOptions {
	readonly cwd?: string;
	readonly timeoutMs?: number;
}

export interface GrepMatch {
	readonly path: string;
	readonly line: number;
	readonly text: string;
}

export interface RepoOptions {
	readonly dir: string;
	readonly ref?: string;
}

export interface ExecEnvDeadlines {
	/** Ceiling for VFS calls and for an exec with no explicit timeout. */
	readonly defaultTimeoutMs: number;
	/** Added to an exec's own timeout so the substrate kills before we do. */
	readonly execGraceMs: number;
}

/**
 * Isolate + VFS substrate. A structural subset of @cloudflare/shell's
 * `StateBackend`; the agent passes a `FileSystemStateBackend` over its
 * workspace, tests pass a fake.
 */
export interface IsolateState {
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	readdirWithFileTypes(path: string): Promise<Array<{ name: string; type: string }>>;
	exists(path: string): Promise<boolean>;
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
	searchFiles(
		pattern: string,
		query: string,
		options?: { maxMatches?: number; caseSensitive?: boolean },
	): Promise<Array<{ path: string; matches: Array<{ line: number; lineText: string }> }>>;
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

export interface ExecEnvOptions {
	readonly state: IsolateState;
	/** Lazily attaches the container; called at most once, result reused. */
	readonly attachContainer: () => Promise<ContainerBackend>;
	/**
	 * Streams the repo source tree for `ref` into the VFS at `dir`.
	 * `ensureRepo` records the hydration marker and change log around it.
	 */
	readonly hydrateRepo: (dir: string, ref: string) => Promise<void>;
	readonly deadlines: ExecEnvDeadlines;
	/** Working-tree root, shared by both substrates (e.g. /workspace/repo). */
	readonly repoDir: string;
}

/** VFS bookkeeping directory, outside the repo tree. */
const META_DIR = "/.emdash-bot";
const HYDRATED_MARKER = `${META_DIR}/hydrated`;
const CHANGE_LOG = `${META_DIR}/changes.json`;
const GREP_MATCH_LIMIT = 200;

export class ExecEnv {
	readonly #state: IsolateState;
	readonly #attachContainer: () => Promise<ContainerBackend>;
	readonly #hydrateRepo: (dir: string, ref: string) => Promise<void>;
	readonly #deadlines: ExecEnvDeadlines;
	readonly #repoDir: string;
	#containerPromise: Promise<ContainerBackend> | undefined;

	constructor(options: ExecEnvOptions) {
		this.#state = options.state;
		this.#attachContainer = options.attachContainer;
		this.#hydrateRepo = options.hydrateRepo;
		this.#deadlines = options.deadlines;
		this.#repoDir = options.repoDir;
	}

	/**
	 * Stand the repo up in the VFS at `ref` (branch, tag, or commit SHA).
	 * Idempotent per ref: a marker records what was hydrated, and a re-entry
	 * with the same ref reuses the tree along with any recorded agent edits.
	 */
	async ensureRepo(options: RepoOptions): Promise<void> {
		const ref = options.ref ?? "main";
		if ((await this.#readMarker()) === ref) return;
		await this.#bounded(this.#state.rm(options.dir, { recursive: true, force: true }), "rm");
		await this.#hydrateRepo(options.dir, ref);
		await this.#bounded(this.#state.mkdir(META_DIR, { recursive: true }), "mkdir");
		await this.#bounded(this.#state.writeFile(CHANGE_LOG, "[]"), "writeFile");
		await this.#bounded(this.#state.writeFile(HYDRATED_MARKER, ref), "writeFile");
	}

	async #readMarker(): Promise<string | null> {
		try {
			return await this.#bounded(this.#state.readFile(HYDRATED_MARKER), "readFile");
		} catch {
			return null;
		}
	}

	readFile(path: string): Promise<string> {
		return this.#bounded(this.#state.readFile(path), "readFile");
	}

	async writeFile(path: string, content: string): Promise<void> {
		await this.#bounded(this.#state.writeFile(path, content), "writeFile");
		await this.#recordChange(path);
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

	ls(path: string): Promise<Array<{ name: string; type: string }>> {
		return this.#bounded(this.#state.readdirWithFileTypes(path), "readdir");
	}

	async grep(
		pattern: string,
		path: string,
		options?: { ignoreCase?: boolean },
	): Promise<GrepMatch[]> {
		const files = await this.#bounded(
			this.#state.searchFiles(`${path.replace(TRAILING_SLASH, "")}/**/*`, pattern, {
				maxMatches: GREP_MATCH_LIMIT,
				caseSensitive: options?.ignoreCase !== true,
			}),
			"searchFiles",
		);
		return files.flatMap((file) =>
			file.matches.map((match) => ({ path: file.path, line: match.line, text: match.lineText })),
		);
	}

	/** Run a shell command in the container, materializing VFS edits first. */
	async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		const timeoutMs = options.timeoutMs;
		const deadlineMs = timeoutMs
			? timeoutMs + this.#deadlines.execGraceMs
			: this.#deadlines.defaultTimeoutMs;
		const cwd = options.cwd ?? this.#repoDir;
		const container = await this.container();
		await this.#materializeChanges(container);
		return withDeadline(
			container.exec(command, { cwd, ...(timeoutMs ? { timeoutMs } : {}) }),
			deadlineMs,
			"container exec",
		);
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

	/** Attach the container once and reuse it. */
	container(): Promise<ContainerBackend> {
		return (this.#containerPromise ??= withDeadline(
			this.#attachContainer(),
			this.#deadlines.defaultTimeoutMs,
			"container attach",
		).catch((error: unknown) => {
			this.#containerPromise = undefined;
			throw error;
		}));
	}

	async #recordChange(path: string): Promise<void> {
		if (!path.startsWith(`${this.#repoDir}/`)) return;
		const changed = await this.#readChangeLog();
		if (changed.includes(path)) return;
		changed.push(path);
		await this.#bounded(this.#state.mkdir(META_DIR, { recursive: true }), "mkdir");
		await this.#bounded(this.#state.writeFile(CHANGE_LOG, JSON.stringify(changed)), "writeFile");
	}

	async #readChangeLog(): Promise<string[]> {
		try {
			const raw = await this.#bounded(this.#state.readFile(CHANGE_LOG), "readFile");
			const parsed: unknown = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
		} catch {
			return [];
		}
	}

	/**
	 * Replay the change log onto the container checkout. Re-reads each path
	 * from the VFS at replay time, so the container always receives the
	 * current content no matter which isolate recorded the change.
	 */
	async #materializeChanges(container: ContainerBackend): Promise<void> {
		for (const path of await this.#readChangeLog()) {
			await container.writeFile(path, await this.readFile(path));
		}
	}

	#bounded<T>(operation: PromiseLike<T>, operationName: string): Promise<T> {
		return withDeadline(operation, this.#deadlines.defaultTimeoutMs, `VFS ${operationName}`);
	}
}

const TRAILING_SLASH = /\/+$/;
const PATH_SEPARATOR = /[/\\]/;

/** Single-quote a shell argument for a container command line. */
export function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Adapt a @cloudflare/sandbox session to the ContainerBackend seam. */
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
