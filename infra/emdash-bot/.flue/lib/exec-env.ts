// execEnv: the single seam over the investigation's two execution substrates.
//
//   - Isolate + VFS: a @cloudflare/shell Workspace living in the agent DO's
//     own SQLite (large files spill to R2). Holds the hydrated repo tree and
//     every agent edit. Reads, searches, and edits run here with no container.
//   - Container: @cloudflare/sandbox. Runs the toolchain (git, pnpm, astro,
//     vitest, agent-browser) against its own native checkout.
//
// The VFS is authoritative for source. Direct edits are recorded immediately;
// shell-produced candidate changes are checkpointed back into the same VFS
// after each command. Before another container attaches, those paths and
// deletions are replayed onto its clean checkout. Container-only files such as
// node_modules and build output remain disposable.

import type { Sandbox } from "@cloudflare/sandbox";

import type { CandidatePublication } from "./candidate-publisher.js";
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
	/** Overall ceiling for attaching or rebuilding the container checkout. */
	readonly attachTimeoutMs: number;
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
	readFileBytes(path: string): Promise<Uint8Array>;
	writeFile(path: string, content: string): Promise<void>;
	writeFileBytes(path: string, content: Uint8Array): Promise<void>;
	lstat(path: string): Promise<{ type: string } | null>;
	symlink(target: string, linkPath: string): Promise<void>;
	readlink(path: string): Promise<string>;
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
	isReady(): Promise<boolean>;
	exec(
		command: string,
		options?: { cwd?: string; timeoutMs?: number },
	): Promise<{ exitCode: number; stdout: string; stderr: string }>;
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	readFileBytes(path: string): Promise<Uint8Array>;
}

export interface ExecEnvOptions {
	readonly state: IsolateState;
	/** Lazily attaches the container; called at most once, result reused. */
	readonly attachContainer: () => Promise<ContainerBackend>;
	/** Separate credentialed checkout used only by trusted publication code. */
	readonly attachPublisherContainer?: () => Promise<ContainerBackend>;
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
const DELETED_LOG = `${META_DIR}/deleted.json`;
const MODE_LOG = `${META_DIR}/modes.json`;
const GREP_MATCH_LIMIT = 200;
const CANDIDATE_FILE_LIMIT = 200;
const DISALLOWED_CANDIDATE_PATHS = [".git/", ".github/workflows/", ".bot-artifacts/"];
const CANDIDATE_BRANCH = /^bot\/fix-\d+$/;
const ARTIFACT_BRANCH = /^bot\/artifacts-\d+$/;
const LINE_BREAK = /\r?\n/;
const WHITESPACE_SEQUENCE = /\s+/;

export class ExecEnv {
	readonly #state: IsolateState;
	readonly #attachContainer: () => Promise<ContainerBackend>;
	readonly #attachPublisherContainer: () => Promise<ContainerBackend>;
	readonly #hydrateRepo: (dir: string, ref: string) => Promise<void>;
	readonly #deadlines: ExecEnvDeadlines;
	readonly #repoDir: string;
	#containerPromise: Promise<ContainerBackend> | undefined;
	#publisherPromise: Promise<ContainerBackend> | undefined;
	#containerRecoveryPromise: Promise<ContainerBackend> | undefined;
	#snapshotBaseRef: string | undefined;
	#mutationTail: Promise<void> = Promise.resolve();

	constructor(options: ExecEnvOptions) {
		this.#state = options.state;
		this.#attachContainer = options.attachContainer;
		this.#attachPublisherContainer = options.attachPublisherContainer ?? options.attachContainer;
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
		this.#snapshotBaseRef = ref;
		if ((await this.#readMarker()) === ref) return;
		await this.#bounded(this.#state.rm(options.dir, { recursive: true, force: true }), "rm");
		await this.#bounded(this.#hydrateRepo(options.dir, ref), "hydrateRepo");
		await this.#bounded(this.#state.mkdir(META_DIR, { recursive: true }), "mkdir");
		await this.#bounded(this.#state.writeFile(CHANGE_LOG, "[]"), "writeFile");
		await this.#bounded(this.#state.writeFile(DELETED_LOG, "[]"), "writeFile");
		await this.#bounded(this.#state.writeFile(MODE_LOG, "{}"), "writeFile");
		await this.#bounded(this.#state.writeFile(HYDRATED_MARKER, ref), "writeFile");
	}

	async ensureContainerReady(): Promise<void> {
		const container = await this.container();
		await this.#materializeChanges(container);
	}

	async #readMarker(): Promise<string | null> {
		if (!(await this.#bounded(this.#state.exists(HYDRATED_MARKER), "exists"))) return null;
		return this.#bounded(this.#state.readFile(HYDRATED_MARKER), "readFile");
	}

	readFile(path: string): Promise<string> {
		return this.#bounded(this.#state.readFile(path), "readFile");
	}

	writeFile(path: string, content: string): Promise<void> {
		return this.#enqueueMutation(() => this.#writeFile(path, content));
	}

	/** Replace an exact substring; the file must contain it exactly once. */
	edit(path: string, oldString: string, newString: string): Promise<void> {
		return this.#enqueueMutation(async () => {
			this.#assertEditablePath(path);
			const current = await this.readFile(path);
			if (!current.includes(oldString)) throw new Error(`edit target not found in ${path}`);
			const first = current.indexOf(oldString);
			if (current.slice(first + oldString.length).includes(oldString)) {
				throw new Error(`edit target is not unique in ${path}`);
			}
			await this.#writeFile(
				path,
				current.slice(0, first) + newString + current.slice(first + oldString.length),
			);
		});
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

	async execWritable(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		const result = await this.exec(command, options);
		await this.checkpointContainer();
		return result;
	}

	async checkpointContainer(): Promise<void> {
		const baseRef = this.#snapshotBaseRef;
		if (!baseRef) throw new Error("workspace snapshot base is not initialized");
		const container = await this.container();
		const pathsResult = await this.#bounded(
			container.exec(
				pipefailCommand(
					`{ git diff --name-only -z ${quote(baseRef)} --; git ls-files --others --exclude-standard -z; } | sort -zu | base64 -w0`,
				),
				{ cwd: this.#repoDir },
			),
			"candidate checkpoint paths",
		);
		if (pathsResult.exitCode !== 0) {
			throw new Error(`candidate checkpoint failed: ${lastOutput(pathsResult)}`);
		}
		const paths = parseCandidatePaths(
			decodeBase64Utf8(pathsResult.stdout, "candidate checkpoint paths"),
		);
		if (paths.length > CANDIDATE_FILE_LIMIT) {
			throw new Error(`candidate changes ${paths.length} files; limit is ${CANDIDATE_FILE_LIMIT}`);
		}
		const previousPaths = new Set([
			...(await this.#readChangeLog()),
			...(await this.#readDeletedLog()),
			...Object.keys(await this.#readModeLog()),
		]);
		const currentPaths = new Set(paths.map((path) => `${this.#repoDir}/${path}`));
		for (const path of previousPaths) {
			if (currentPaths.has(path)) continue;
			await this.#checkpointPath(container, path);
		}
		const changed: string[] = [];
		const deleted: string[] = [];
		const modes: Record<string, "100644" | "100755"> = {};
		for (const relativePath of paths) {
			assertCandidatePath(relativePath);
			const path = `${this.#repoDir}/${relativePath}`;
			const state = await this.#checkpointPath(container, path);
			if (state.kind !== "missing") {
				changed.push(path);
				if (state.kind === "file") modes[path] = state.executable ? "100755" : "100644";
			} else {
				deleted.push(path);
			}
		}
		await this.#bounded(this.#state.mkdir(META_DIR, { recursive: true }), "mkdir");
		await Promise.all([
			this.#bounded(this.#state.writeFile(CHANGE_LOG, JSON.stringify(changed)), "writeFile"),
			this.#bounded(this.#state.writeFile(DELETED_LOG, JSON.stringify(deleted)), "writeFile"),
			this.#bounded(this.#state.writeFile(MODE_LOG, JSON.stringify(modes)), "writeFile"),
		]);
	}

	async #checkpointPath(container: ContainerBackend, path: string): Promise<CandidatePathState> {
		const state = await this.#containerPathState(container, path);
		await this.#bounded(this.#state.rm(path, { force: true }), "rm");
		if (state.kind === "symlink") {
			assertSafeSymlinkTarget(path.slice(`${this.#repoDir}/`.length), state.target);
			await this.#bounded(this.#state.symlink(state.target, path), "symlink");
		} else if (state.kind === "file") {
			const bytes = await this.#bounded(container.readFileBytes(path), "candidate checkpoint read");
			await this.#bounded(this.#state.writeFileBytes(path, bytes), "writeFileBytes");
		}
		return state;
	}

	async #containerPathState(
		container: ContainerBackend,
		path: string,
	): Promise<CandidatePathState> {
		const result = await this.#bounded(
			container.exec(
				pipefailCommand(
					`if test -L ${quote(path)}; then printf 'symlink\\0'; readlink -n -- ${quote(path)}; elif test -f ${quote(path)}; then if test -x ${quote(path)}; then printf 'executable\\0'; else printf 'file\\0'; fi; else printf 'missing\\0'; fi | base64 -w0`,
				),
				{ cwd: this.#repoDir },
			),
			"candidate checkpoint path",
		);
		if (result.exitCode !== 0) {
			throw new Error(`candidate checkpoint path inspection failed: ${lastOutput(result)}`);
		}
		const raw = decodeBase64Utf8(result.stdout, "candidate checkpoint path");
		const [kind, value, ...extra] = raw.split("\0");
		if (kind === "symlink" && value !== undefined && value !== "" && extra.length === 0) {
			return { kind, target: value };
		}
		if (
			(kind === "file" || kind === "executable" || kind === "missing") &&
			value === "" &&
			extra.length === 0
		) {
			return kind === "missing" ? { kind } : { kind: "file", executable: kind === "executable" };
		}
		throw new Error("candidate checkpoint path returned an invalid entry");
	}

	async execReadOnly(command: string, options: ExecOptions = {}): Promise<ExecResult> {
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
		const afterTreeSha = await this.#candidateTreeSha(container);
		if (afterTreeSha !== beforeTreeSha) {
			await this.#restoreContainerCandidate(container);
			throw new Error(
				"container command modified the candidate; apply source changes with edit_file/write_file and rerun a check-only command",
			);
		}
		return result;
	}

	async publishCandidate(input: {
		branch: string;
		runId: string;
		commitMessage: string;
		baseRef: string;
		expectedPreviousSha: string | null;
	}): Promise<CandidatePublication> {
		if (!CANDIDATE_BRANCH.test(input.branch)) {
			throw new Error(`invalid candidate branch: ${input.branch}`);
		}
		const commitMessage = input.commitMessage.trim();
		if (commitMessage === "") throw new Error("candidate commit message is empty");
		const container = await this.publisherContainer();
		await this.#restoreContainerBase(container, input.baseRef);
		await this.#materializeChanges(container);
		await this.#stageCandidate(container);

		const [base, tree, names] = await Promise.all([
			this.#bounded(
				container.exec(pipefailCommand("git rev-parse HEAD"), { cwd: this.#repoDir }),
				"candidate base",
			),
			this.#bounded(
				container.exec(pipefailCommand("git write-tree"), { cwd: this.#repoDir }),
				"candidate tree",
			),
			this.#bounded(
				container.exec(pipefailCommand("git diff --cached --name-only -z HEAD -- | base64 -w0"), {
					cwd: this.#repoDir,
				}),
				"candidate paths",
			),
		]);
		if (base.exitCode !== 0) throw new Error(`candidate base lookup failed: ${lastOutput(base)}`);
		if (tree.exitCode !== 0) throw new Error(`candidate tree failed: ${lastOutput(tree)}`);
		if (names.exitCode !== 0) throw new Error(`candidate paths failed: ${lastOutput(names)}`);
		const files = parseCandidatePaths(decodeBase64Utf8(names.stdout, "candidate paths"));
		if (files.length === 0) throw new Error("candidate has no changes to publish");
		if (files.length > CANDIDATE_FILE_LIMIT) {
			throw new Error(`candidate changes ${files.length} files; limit is ${CANDIDATE_FILE_LIMIT}`);
		}
		for (const path of files) assertCandidatePath(path);

		const treeSha = tree.stdout.trim();
		const runMarker = `EmDash-Run: ${input.runId}`;
		const liveBefore = await this.#remoteBranchSha(container, input.branch);
		if (liveBefore !== input.expectedPreviousSha) {
			if (liveBefore) {
				const fetch = await this.#bounded(
					container.exec(pipefailCommand(`git fetch --depth 1 origin ${quote(liveBefore)}`), {
						cwd: this.#repoDir,
					}),
					"published candidate fetch",
				);
				if (fetch.exitCode !== 0) {
					throw new Error(`published candidate fetch failed: ${lastOutput(fetch)}`);
				}
				const [message, publishedTree] = await Promise.all([
					this.#bounded(
						container.exec(pipefailCommand(`git show -s --format=%B ${quote(liveBefore)}`), {
							cwd: this.#repoDir,
						}),
						"published candidate message",
					),
					this.#bounded(
						container.exec(pipefailCommand(`git rev-parse ${quote(`${liveBefore}^{tree}`)}`), {
							cwd: this.#repoDir,
						}),
						"published candidate tree",
					),
				]);
				if (
					message.exitCode === 0 &&
					publishedTree.exitCode === 0 &&
					hasRunMarker(message.stdout, runMarker) &&
					publishedTree.stdout.trim() === treeSha
				) {
					return { branch: input.branch, commitSha: liveBefore, files };
				}
			}
			throw new Error(
				`candidate branch changed since this run started (expected ${input.expectedPreviousSha ?? "absent"}, found ${liveBefore ?? "absent"})`,
			);
		}

		const commit = await this.#bounded(
			container.exec(
				pipefailCommand(`git commit --no-verify -m ${quote(commitMessage)} -m ${quote(runMarker)}`),
				{ cwd: this.#repoDir },
			),
			"candidate commit",
		);
		if (commit.exitCode !== 0) throw new Error(`candidate commit failed: ${lastOutput(commit)}`);
		const committed = await this.#bounded(
			container.exec(pipefailCommand("git rev-parse HEAD"), { cwd: this.#repoDir }),
			"candidate commit lookup",
		);
		if (committed.exitCode !== 0) {
			throw new Error(`candidate commit lookup failed: ${lastOutput(committed)}`);
		}
		const commitSha = committed.stdout.trim();
		const lease = `--force-with-lease=refs/heads/${input.branch}:${input.expectedPreviousSha ?? ""}`;
		const refspec = `HEAD:refs/heads/${input.branch}`;
		const push = await this.#bounded(
			container.exec(
				pipefailCommand(`git push --porcelain ${quote(lease)} origin ${quote(refspec)}`),
				{ cwd: this.#repoDir },
			),
			"candidate push",
		);
		if (push.exitCode !== 0) throw new Error(`candidate push failed: ${lastOutput(push)}`);
		const publishedSha = await this.#remoteBranchSha(container, input.branch);
		if (publishedSha !== commitSha) {
			throw new Error(
				`candidate branch verification failed (expected ${commitSha}, found ${publishedSha ?? "absent"})`,
			);
		}
		return { branch: input.branch, commitSha, files };
	}

	async publishArtifacts(input: {
		branch: string;
		runId: string;
		baseRef: string;
		files: readonly string[];
	}): Promise<{ branch: string; files: string[] }> {
		if (!ARTIFACT_BRANCH.test(input.branch)) {
			throw new Error(`invalid artifact branch: ${input.branch}`);
		}
		const files = [...new Set(input.files)];
		if (files.length === 0) throw new Error("artifact publication has no files");
		if (files.length > 20) throw new Error("artifact publication exceeds 20 files");
		const contents = await Promise.all(
			files.map(async (name) => ({ name, content: await this.readArtifact(name) })),
		);
		const container = await this.publisherContainer();
		await this.#restoreContainerBase(container, input.baseRef);
		const prepare = await this.#bounded(
			container.exec(
				pipefailCommand(
					`git checkout --orphan ${quote(`emdash-artifacts-${input.runId}`)} && git rm -rf --ignore-unmatch -- . && git clean -fd -- .`,
				),
				{ cwd: this.#repoDir },
			),
			"artifact branch prepare",
		);
		if (prepare.exitCode !== 0) {
			throw new Error(`artifact branch prepare failed: ${lastOutput(prepare)}`);
		}
		for (const artifact of contents) {
			await container.writeFile(
				`${this.#repoDir}/.bot-artifacts/${artifact.name}`,
				artifact.content,
			);
		}
		const commit = await this.#bounded(
			container.exec(
				pipefailCommand(
					`git add -- .bot-artifacts && git commit --no-verify -m ${quote(`chore: store bot artifacts (${input.runId})`)}`,
				),
				{ cwd: this.#repoDir },
			),
			"artifact commit",
		);
		if (commit.exitCode !== 0) throw new Error(`artifact commit failed: ${lastOutput(commit)}`);
		const committed = await this.#bounded(
			container.exec(pipefailCommand("git rev-parse HEAD"), { cwd: this.#repoDir }),
			"artifact commit lookup",
		);
		if (committed.exitCode !== 0) {
			throw new Error(`artifact commit lookup failed: ${lastOutput(committed)}`);
		}
		const commitSha = committed.stdout.trim();
		const liveBefore = await this.#remoteBranchSha(container, input.branch);
		const lease = `--force-with-lease=refs/heads/${input.branch}:${liveBefore ?? ""}`;
		const push = await this.#bounded(
			container.exec(
				pipefailCommand(
					`git push --porcelain ${quote(lease)} origin ${quote(`HEAD:refs/heads/${input.branch}`)}`,
				),
				{ cwd: this.#repoDir },
			),
			"artifact push",
		);
		if (push.exitCode !== 0) throw new Error(`artifact push failed: ${lastOutput(push)}`);
		const publishedSha = await this.#remoteBranchSha(container, input.branch);
		if (publishedSha !== commitSha) {
			throw new Error(
				`artifact branch verification failed (expected ${commitSha}, found ${publishedSha ?? "absent"})`,
			);
		}
		return { branch: input.branch, files };
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

	async #restoreContainerBase(container: ContainerBackend, baseRef: string): Promise<void> {
		const restore = await this.#bounded(
			container.exec(
				pipefailCommand(
					`git reset --hard ${quote(baseRef)} && git clean -fd --exclude=.bot-artifacts/ -- .`,
				),
				{ cwd: this.#repoDir },
			),
			"candidate base restore",
		);
		if (restore.exitCode !== 0) {
			throw new Error(`candidate base restore failed: ${lastOutput(restore)}`);
		}
	}

	async #remoteBranchSha(container: ContainerBackend, branch: string): Promise<string | null> {
		const result = await this.#bounded(
			container.exec(
				pipefailCommand(`git ls-remote --heads origin ${quote(`refs/heads/${branch}`)}`),
				{ cwd: this.#repoDir },
			),
			"candidate branch lookup",
		);
		if (result.exitCode !== 0) {
			throw new Error(`candidate branch lookup failed: ${lastOutput(result)}`);
		}
		const value = result.stdout.trim();
		if (value === "") return null;
		const lines = value.split(LINE_BREAK);
		if (lines.length !== 1) throw new Error("candidate branch lookup returned multiple refs");
		const [sha, ref, ...extra] = (lines[0] ?? "").split(WHITESPACE_SEQUENCE);
		if (!sha || ref !== `refs/heads/${branch}` || extra.length > 0) {
			throw new Error("candidate branch lookup returned an invalid ref");
		}
		return sha;
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

	/** Reuse a live checkout, rebuilding it when the sandbox replaced its container. */
	async container(): Promise<ContainerBackend> {
		const container = await this.#attachedContainer();
		try {
			if (await this.#containerReady(container)) return container;
		} catch {
			this.#containerPromise = undefined;
		}
		return this.#recoverContainer();
	}

	async publisherContainer(): Promise<ContainerBackend> {
		const promise = (this.#publisherPromise ??= withDeadline(
			this.#attachPublisherContainer(),
			this.#deadlines.attachTimeoutMs,
			"publisher container attach",
		).catch((error: unknown) => {
			this.#publisherPromise = undefined;
			throw error;
		}));
		const container = await promise;
		if (await this.#containerReady(container)) return container;
		this.#publisherPromise = undefined;
		throw new Error("publisher container checkout is unavailable");
	}

	#attachedContainer(): Promise<ContainerBackend> {
		return (this.#containerPromise ??= withDeadline(
			this.#attachContainer(),
			this.#deadlines.attachTimeoutMs,
			"container attach",
		).catch((error: unknown) => {
			this.#containerPromise = undefined;
			throw error;
		}));
	}

	#containerReady(container: ContainerBackend): Promise<boolean> {
		return withDeadline(
			container.isReady(),
			this.#deadlines.attachTimeoutMs,
			"container readiness",
		);
	}

	#recoverContainer(): Promise<ContainerBackend> {
		if (this.#containerRecoveryPromise) return this.#containerRecoveryPromise;
		this.#containerPromise = undefined;
		const recovery = (async () => {
			const replacement = await this.#attachedContainer();
			if (!(await this.#containerReady(replacement))) {
				this.#containerPromise = undefined;
				throw new Error("container checkout is unavailable after reattachment");
			}
			return replacement;
		})();
		this.#containerRecoveryPromise = recovery.finally(() => {
			this.#containerRecoveryPromise = undefined;
		});
		return this.#containerRecoveryPromise;
	}

	async #recordChange(path: string): Promise<void> {
		if (!path.startsWith(`${this.#repoDir}/`)) return;
		const changed = await this.#readChangeLog();
		if (changed.includes(path)) return;
		changed.push(path);
		await this.#bounded(this.#state.mkdir(META_DIR, { recursive: true }), "mkdir");
		await this.#bounded(this.#state.writeFile(CHANGE_LOG, JSON.stringify(changed)), "writeFile");
		const deleted = await this.#readDeletedLog();
		if (deleted.includes(path)) {
			await this.#bounded(
				this.#state.writeFile(
					DELETED_LOG,
					JSON.stringify(deleted.filter((entry) => entry !== path)),
				),
				"writeFile",
			);
		}
	}

	async #writeFile(path: string, content: string): Promise<void> {
		this.#assertEditablePath(path);
		await this.#bounded(this.#state.writeFile(path, content), "writeFile");
		await this.#recordChange(path);
	}

	#assertEditablePath(path: string): void {
		const prefix = `${this.#repoDir.replace(TRAILING_SLASH, "")}/`;
		if (!path.startsWith(prefix)) return;
		try {
			assertCandidatePath(path.slice(prefix.length));
		} catch {
			throw new Error(`cannot edit path: ${path}`);
		}
	}

	#enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#mutationTail.then(operation, operation);
		this.#mutationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async #readChangeLog(): Promise<string[]> {
		return this.#readPathLog(CHANGE_LOG);
	}

	async #readDeletedLog(): Promise<string[]> {
		return this.#readPathLog(DELETED_LOG);
	}

	async #readModeLog(): Promise<Record<string, "100644" | "100755">> {
		if (!(await this.#bounded(this.#state.exists(MODE_LOG), "exists"))) return {};
		const raw = await this.#bounded(this.#state.readFile(MODE_LOG), "readFile");
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new Error("invalid VFS mode log: malformed JSON", { cause: error });
		}
		if (!isCandidateModeLog(parsed)) throw new Error("invalid VFS mode log");
		for (const path of Object.keys(parsed)) this.#assertLoggedPath(path);
		return parsed;
	}

	async #readPathLog(logPath: string): Promise<string[]> {
		if (!(await this.#bounded(this.#state.exists(logPath), "exists"))) return [];
		const raw = await this.#bounded(this.#state.readFile(logPath), "readFile");
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new Error("invalid VFS change log: malformed JSON", { cause: error });
		}
		if (!Array.isArray(parsed) || parsed.some((path) => typeof path !== "string")) {
			throw new Error("invalid VFS path log: expected an array of paths");
		}
		for (const path of parsed) this.#assertLoggedPath(path);
		return parsed;
	}

	#assertLoggedPath(path: string): void {
		const prefix = `${this.#repoDir}/`;
		if (!path.startsWith(prefix)) {
			throw new Error("invalid VFS change log: path outside repository");
		}
		try {
			assertCandidatePath(path.slice(prefix.length));
		} catch (error) {
			throw new Error("invalid VFS change log: forbidden repository path", { cause: error });
		}
	}

	/**
	 * Replay the change log onto the container checkout. Re-reads each path
	 * from the VFS at replay time, so the container always receives the
	 * current content no matter which isolate recorded the change.
	 */
	async #materializeChanges(container: ContainerBackend): Promise<void> {
		const modes = await this.#readModeLog();
		for (const path of await this.#readDeletedLog()) {
			const result = await this.#bounded(
				container.exec(`rm -f -- ${quote(path)}`),
				"materialize deletion",
			);
			if (result.exitCode !== 0) {
				throw new Error(`candidate deletion replay failed: ${lastOutput(result)}`);
			}
		}
		for (const path of await this.#readChangeLog()) {
			const entry = await this.#bounded(this.#state.lstat(path), "lstat");
			if (entry?.type === "symlink") {
				const target = await this.#bounded(this.#state.readlink(path), "readlink");
				assertSafeSymlinkTarget(path.slice(`${this.#repoDir}/`.length), target);
				const result = await this.#bounded(
					container.exec(`rm -f -- ${quote(path)} && ln -s -- ${quote(target)} ${quote(path)}`),
					"materialize symlink",
				);
				if (result.exitCode !== 0) {
					throw new Error(`candidate symlink replay failed: ${lastOutput(result)}`);
				}
				continue;
			}
			if (entry?.type !== "file") throw new Error(`candidate change is not a file: ${path}`);
			const mode = modes[path];
			const prepare = await this.#bounded(
				container.exec(
					mode
						? `rm -f -- ${quote(path)}`
						: `if test -L ${quote(path)}; then rm -f -- ${quote(path)}; fi`,
				),
				"materialize file",
			);
			if (prepare.exitCode !== 0) {
				throw new Error(`candidate file replay failed: ${lastOutput(prepare)}`);
			}
			await container.writeFile(
				path,
				await this.#bounded(this.#state.readFileBytes(path), "readFileBytes"),
			);
			if (mode) {
				const chmod = await this.#bounded(
					container.exec(`chmod ${mode === "100755" ? "755" : "644"} ${quote(path)}`),
					"materialize mode",
				);
				if (chmod.exitCode !== 0) {
					throw new Error(`candidate mode replay failed: ${lastOutput(chmod)}`);
				}
			}
		}
	}

	#bounded<T>(operation: PromiseLike<T>, operationName: string): Promise<T> {
		return withDeadline(operation, this.#deadlines.defaultTimeoutMs, `VFS ${operationName}`);
	}
}

const TRAILING_SLASH = /\/+$/;
const PATH_SEPARATOR = /[/\\]/;

type CandidatePathState =
	| { kind: "missing" }
	| { kind: "file"; executable: boolean }
	| { kind: "symlink"; target: string };

function isCandidateModeLog(value: unknown): value is Record<string, "100644" | "100755"> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every((mode) => mode === "100644" || mode === "100755")
	);
}

function assertSafeSymlinkTarget(linkPath: string, target: string): void {
	if (target.startsWith("/") || target === "") {
		throw new Error(`candidate symlink target escapes the repository: ${linkPath} -> ${target}`);
	}
	const resolved = linkPath.split("/").slice(0, -1);
	for (const segment of target.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (resolved.length === 0) {
				throw new Error(
					`candidate symlink target escapes the repository: ${linkPath} -> ${target}`,
				);
			}
			resolved.pop();
		} else {
			resolved.push(segment);
		}
	}
}

function decodeBase64Utf8(encoded: string, label: string): string {
	const value = encoded.trim();
	if (value === "") return "";
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
			decodeBase64Bytes(value),
		);
	} catch (error) {
		throw new Error(`${label} was not valid base64-encoded UTF-8`, { cause: error });
	}
}

function decodeBase64Bytes(encoded: string): Uint8Array {
	const binary = atob(encoded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function encodeBase64Bytes(bytes: Uint8Array): string {
	const chunks: string[] = [];
	const chunkSize = 32_768;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
	}
	return btoa(chunks.join(""));
}

function parseCandidatePaths(raw: string): string[] {
	if (raw === "") return [];
	const paths = raw.split("\0");
	if (paths.at(-1) !== "") throw new Error("candidate paths were not null-delimited");
	paths.pop();
	if (paths.some((path) => path === "")) throw new Error("candidate paths contained an empty path");
	return paths;
}

function hasRunMarker(message: string, marker: string): boolean {
	return message.split(LINE_BREAK).some((line) => line.trim() === marker);
}

function assertCandidatePath(path: string): void {
	const segments = path.split("/");
	if (
		path === "" ||
		path.startsWith("/") ||
		segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
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
		isReady: async () => true,
		async exec(command, options) {
			const result = await sandbox.exec(command, {
				...(options?.cwd ? { cwd: options.cwd } : {}),
				...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
			});
			return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
		},
		async writeFile(path, content) {
			if (typeof content === "string") {
				await sandbox.writeFile(path, content);
				return;
			}
			await sandbox.writeFile(path, encodeBase64Bytes(content), { encoding: "base64" });
		},
		async readFileBytes(path) {
			const { content } = await sandbox.readFile(path, { encoding: "base64" });
			return decodeBase64Bytes(content);
		},
	};
}
