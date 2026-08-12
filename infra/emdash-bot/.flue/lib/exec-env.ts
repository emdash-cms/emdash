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

import type { CandidateChange, CandidateSnapshot, GitTreeMode } from "./candidate-publisher.js";
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
const CANDIDATE_FILE_LIMIT = 200;
const CANDIDATE_FILE_SIZE_LIMIT = 2 * 1024 * 1024;
const CANDIDATE_TOTAL_SIZE_LIMIT = 10 * 1024 * 1024;
const DISALLOWED_CANDIDATE_PATHS = [".git/", ".github/workflows/", ".bot-artifacts/"];
const RAW_DIFF_HEADER = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])$/;

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
			container.exec(pipefailCommand(command), { cwd, ...(timeoutMs ? { timeoutMs } : {}) }),
			deadlineMs,
			"container exec",
		);
	}

	async runCheck(
		command: string,
		options: ExecOptions = {},
	): Promise<{ result: ExecResult; candidateTreeSha: string }> {
		const timeoutMs = options.timeoutMs;
		const deadlineMs = timeoutMs
			? timeoutMs + this.#deadlines.execGraceMs
			: this.#deadlines.defaultTimeoutMs;
		const cwd = options.cwd ?? this.#repoDir;
		const container = await this.container();
		await this.#materializeChanges(container);
		const beforeTreeSha = await this.#candidateTreeSha(container);
		const result = await withDeadline(
			container.exec(pipefailCommand(command), { cwd, ...(timeoutMs ? { timeoutMs } : {}) }),
			deadlineMs,
			"container check",
		);
		const candidateTreeSha = await this.#candidateTreeSha(container);
		if (candidateTreeSha !== beforeTreeSha) {
			await this.#restoreContainerCandidate(container);
			throw new Error(
				"verification command modified the candidate; apply source changes with edit_file/write_file and rerun a check-only command",
			);
		}
		return { result, candidateTreeSha };
	}

	/** Stage the working tree and return a bounded snapshot for Worker-owned publication. */
	async snapshotCandidate(): Promise<CandidateSnapshot> {
		const container = await this.container();
		await this.#materializeChanges(container);
		await this.#stageCandidate(container);
		const [base, tree, diff] = await Promise.all([
			this.#bounded(
				container.exec(pipefailCommand("git rev-parse HEAD"), { cwd: this.#repoDir }),
				"candidate base",
			),
			this.#bounded(
				container.exec(pipefailCommand("git write-tree"), { cwd: this.#repoDir }),
				"candidate tree",
			),
			this.#bounded(
				container.exec(
					pipefailCommand("git diff --cached --raw --abbrev=64 --no-renames -z HEAD --"),
					{
						cwd: this.#repoDir,
					},
				),
				"candidate diff",
			),
		]);
		if (base.exitCode !== 0) throw new Error(`candidate base lookup failed: ${lastOutput(base)}`);
		if (tree.exitCode !== 0) throw new Error(`candidate tree lookup failed: ${lastOutput(tree)}`);
		if (diff.exitCode !== 0) throw new Error(`candidate diff failed: ${lastOutput(diff)}`);
		const entries = parseRawGitDiff(diff.stdout);
		if (entries.length === 0) throw new Error("candidate has no staged changes");
		if (entries.length > CANDIDATE_FILE_LIMIT) {
			throw new Error(
				`candidate changes ${entries.length} files; limit is ${CANDIDATE_FILE_LIMIT}`,
			);
		}

		const changes: CandidateChange[] = [];
		let totalBytes = 0;
		for (const entry of entries) {
			assertCandidatePath(entry.path);
			if (entry.deleted) {
				changes.push({ path: entry.path, mode: entry.mode, content: null });
				continue;
			}
			if (!entry.blobSha) throw new Error(`candidate staged blob is missing for ${entry.path}`);
			const content = await this.#readStagedBlob(container, entry.blobSha);
			if (content.byteLength > CANDIDATE_FILE_SIZE_LIMIT) {
				throw new Error(
					`candidate file ${entry.path} is ${content.byteLength} bytes; limit is ${CANDIDATE_FILE_SIZE_LIMIT}`,
				);
			}
			totalBytes += content.byteLength;
			if (totalBytes > CANDIDATE_TOTAL_SIZE_LIMIT) {
				throw new Error(`candidate content exceeds ${CANDIDATE_TOTAL_SIZE_LIMIT} bytes`);
			}
			await assertGitBlobContent(content, entry.blobSha, entry.path);
			changes.push({ path: entry.path, mode: entry.mode, content });
		}
		return { baseCommitSha: base.stdout.trim(), treeSha: tree.stdout.trim(), changes };
	}

	async candidateTreeSha(options: { materialize?: boolean } = {}): Promise<string> {
		const container = await this.container();
		if (options.materialize !== false) await this.#materializeChanges(container);
		return this.#candidateTreeSha(container);
	}

	async #candidateTreeSha(container: ContainerBackend): Promise<string> {
		await this.#stageCandidate(container);
		const tree = await this.#bounded(
			container.exec(pipefailCommand("git write-tree"), { cwd: this.#repoDir }),
			"candidate tree",
		);
		if (tree.exitCode !== 0) throw new Error(`candidate tree lookup failed: ${lastOutput(tree)}`);
		return tree.stdout.trim();
	}

	async #restoreContainerCandidate(container: ContainerBackend): Promise<void> {
		const restore = await this.#bounded(
			container.exec(
				pipefailCommand("git reset --hard HEAD && git clean -fd --exclude=.bot-artifacts/ -- ."),
				{ cwd: this.#repoDir },
			),
			"candidate restore",
		);
		if (restore.exitCode !== 0) {
			throw new Error(`candidate restore failed: ${lastOutput(restore)}`);
		}
		await this.#materializeChanges(container);
	}

	async #stageCandidate(container: ContainerBackend): Promise<void> {
		const stage = await this.#bounded(
			container.exec(
				pipefailCommand("git add --all -- . && git reset --quiet HEAD -- .bot-artifacts"),
				{
					cwd: this.#repoDir,
				},
			),
			"candidate stage",
		);
		if (stage.exitCode !== 0) {
			throw new Error(`candidate staging failed: ${lastOutput(stage)}`);
		}
	}

	async #readStagedBlob(container: ContainerBackend, blobSha: string): Promise<Uint8Array> {
		const tempPath = `/tmp/emdash-candidate-${crypto.randomUUID()}`;
		let content: Uint8Array | undefined;
		let readFailure: unknown;
		try {
			const materialize = await this.#bounded(
				container.exec(
					pipefailCommand(`git cat-file blob ${quote(blobSha)} > ${quote(tempPath)}`),
					{ cwd: this.#repoDir },
				),
				"candidate staged file",
			);
			if (materialize.exitCode !== 0) {
				throw new Error(`candidate staged file read failed: ${lastOutput(materialize)}`);
			}
			content = await this.#bounded(
				container.readFileBytes(tempPath),
				"candidate staged file read",
			);
		} catch (error) {
			readFailure = error;
		}

		let cleanupFailure: unknown;
		try {
			const cleanup = await this.#bounded(
				container.exec(pipefailCommand(`rm -f -- ${quote(tempPath)}`), { cwd: "/" }),
				"candidate staged file cleanup",
			);
			if (cleanup.exitCode !== 0) {
				throw new Error(`candidate staged file cleanup failed: ${lastOutput(cleanup)}`);
			}
		} catch (error) {
			cleanupFailure = error;
		}

		if (readFailure && cleanupFailure) {
			throw new AggregateError(
				[readFailure, cleanupFailure],
				"candidate staged file read and cleanup failed",
			);
		}
		if (readFailure) throw readFailure;
		if (cleanupFailure) throw cleanupFailure;
		if (!content) throw new Error("candidate staged file read returned no content");
		return content;
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

interface RawDiffEntry {
	path: string;
	mode: GitTreeMode;
	deleted: boolean;
	blobSha: string | null;
}

export function parseRawGitDiff(raw: string): RawDiffEntry[] {
	if (raw === "") return [];
	const tokens = raw.split("\0");
	if (tokens.at(-1) !== "" || tokens.length % 2 !== 1) {
		throw new Error("malformed staged diff");
	}
	const entries: RawDiffEntry[] = [];
	for (let index = 0; index < tokens.length - 1; index += 2) {
		const header = tokens[index];
		const path = tokens[index + 1];
		if (!header || !path) throw new Error("malformed staged diff");
		const match = RAW_DIFF_HEADER.exec(header);
		if (!match) throw new Error(`unsupported staged diff entry: ${header}`);
		const [, oldMode, newMode, , newSha, status] = match;
		if (status === "U") throw new Error(`candidate contains an unresolved merge at ${path}`);
		const deleted = status === "D";
		const mode = gitTreeMode(deleted ? oldMode : newMode);
		if (mode === "120000") throw new Error(`candidate cannot publish symlink: ${path}`);
		entries.push({ path, mode, deleted, blobSha: deleted ? null : (newSha ?? null) });
	}
	return entries;
}

async function assertGitBlobContent(
	content: Uint8Array,
	expectedSha: string,
	path: string,
): Promise<void> {
	const algorithm =
		expectedSha.length === 40 ? "SHA-1" : expectedSha.length === 64 ? "SHA-256" : null;
	if (!algorithm) throw new Error(`unsupported candidate blob SHA for ${path}`);
	const header = new TextEncoder().encode(`blob ${content.byteLength}\0`);
	const input = new Uint8Array(header.byteLength + content.byteLength);
	input.set(header);
	input.set(content, header.byteLength);
	const digest = new Uint8Array(await crypto.subtle.digest(algorithm, input));
	let actualSha = "";
	for (const byte of digest) actualSha += byte.toString(16).padStart(2, "0");
	if (actualSha !== expectedSha) {
		throw new Error(`candidate content for ${path} does not match staged blob ${expectedSha}`);
	}
}

function gitTreeMode(mode: string | undefined): GitTreeMode {
	if (mode === "100644" || mode === "100755" || mode === "120000") return mode;
	throw new Error(`unsupported candidate file mode: ${mode ?? "missing"}`);
}

function assertCandidatePath(path: string): void {
	if (
		path === "" ||
		path.startsWith("/") ||
		path.split("/").includes("..") ||
		DISALLOWED_CANDIDATE_PATHS.some(
			(prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix),
		)
	) {
		throw new Error(`candidate cannot publish path: ${path}`);
	}
}

function lastOutput(result: ExecResult): string {
	return (result.stderr || result.stdout || `exit ${result.exitCode}`).trim().slice(-500);
}

/** Single-quote a shell argument for a container command line. */
export function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function pipefailCommand(command: string): string {
	return `bash -o pipefail -c ${quote(command)}`;
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
