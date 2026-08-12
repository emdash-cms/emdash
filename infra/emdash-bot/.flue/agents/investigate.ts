"use agent";

import {
	DynamicWorkerExecutor,
	type ResolvedProvider,
	resolveProvider,
} from "@cloudflare/codemode";
import { getSandbox } from "@cloudflare/sandbox";
import { FileSystemStateBackend, Workspace, WorkspaceFileSystem } from "@cloudflare/shell";
import { STATE_METHODS, type StateBackend, stateToolsFromBackend } from "@cloudflare/shell/workers";
import {
	defineTool,
	type AgentProps,
	useAgentFinish,
	useAgentStart,
	useDataWriter,
	useInitialData,
	useModel,
	usePersistentState,
	useSkill,
	useTool,
} from "@flue/runtime";
import { getCloudflareContext } from "@flue/runtime/cloudflare";
import { env as workerEnv } from "cloudflare:workers";
import * as v from "valibot";

import {
	publishCandidate,
	requireCandidatePublication,
	type CandidateGitHub,
	type CandidatePublication,
	type CandidateSnapshot,
} from "../lib/candidate-publisher.js";
import {
	type ContainerBackend,
	ExecEnv,
	type ExecResult,
	fromSandbox,
	quote,
} from "../lib/exec-env.js";
import { createPushCapability, PUSH_CAPABILITY_HEADER } from "../lib/github-proxy.js";
import {
	createBranch,
	createGitBlob,
	createGitCommit,
	createGitTree,
	getBranchSha,
	getGitCommit,
	mintInstallationToken,
	readAppCreds,
	readRepoContext,
	updateBranch,
} from "../lib/github.js";
import { applyInvestigationResult } from "../lib/investigation-result.js";
import { untarInto } from "../lib/untar.js";
import {
	assertVerificationCommand,
	passingVerificationRecords,
	type VerificationRecord,
} from "../lib/verification.js";
import diagnoseSkill from "../skills/diagnose/SKILL.md";
import fixSkill from "../skills/fix/SKILL.md";
import implementSkill from "../skills/implement/SKILL.md";
import investigateSkill from "../skills/investigate/SKILL.md";
import reproAdminSkill from "../skills/repro-admin/SKILL.md";
import reproApiSkill from "../skills/repro-api/SKILL.md";
import reproPublicSkill from "../skills/repro-public/SKILL.md";
import verifySkill from "../skills/verify/SKILL.md";

const REPO_DIR = "/workspace/repo";
const DEFAULT_RPC_TIMEOUT_MS = 2 * 60_000;
const EXEC_GRACE_MS = 30_000;
const CLONE_DEPTH = 50;
const DEADLINES = { defaultTimeoutMs: DEFAULT_RPC_TIMEOUT_MS, execGraceMs: EXEC_GRACE_MS };
/**
 * Ceiling on any single tool result returned to the model. Unbounded tool
 * output accumulates across a long investigation until the conversation
 * exceeds the model's context window and the run dies mid-flight.
 */
const TOOL_RESULT_LIMIT = 49_152;
const RESULT_SUMMARY_LIMIT = 2_000;

function truncateToolResult(text: string): string {
	if (text.length <= TOOL_RESULT_LIMIT) return text;
	return `${text.slice(0, TOOL_RESULT_LIMIT)}\n… [truncated: showing ${TOOL_RESULT_LIMIT} of ${text.length} characters. Continue with read_file offset/limit, grep with a tighter pattern, or aggregate with the code tool.]`;
}

const initialDataSchema = v.object({
	runId: v.pipe(v.string(), v.minLength(1)),
	issueNumber: v.number(),
	mode: v.picklist(["repro", "implement", "revise", "diagnose", "fix"]),
	arg: v.optional(v.nullable(v.string())),
	issueTitle: v.pipe(v.string(), v.minLength(1)),
	issueBody: v.string(),
	previousBranchSha: v.nullable(v.string()),
	/**
	 * Explicit base ref (branch, tag, or commit SHA) to stand the workspace up
	 * at, overriding the mode default. The eval harness sets this to a fixing
	 * PR's pre-fix commit so a confirmed bug reproduces.
	 */
	baseRef: v.optional(v.nullable(v.string())),
});

const screenshotSchema = v.object({
	filename: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
	description: v.optional(v.string()),
});

const resultSchema = v.pipe(
	v.object({
		skipped: v.optional(v.boolean()),
		reproduced: v.optional(v.boolean()),
		/** How the failure was demonstrated. Required evidence for `reproduced`. */
		demonstration: v.optional(
			v.picklist(["failing-test", "command-error", "browser-transcript", "none"]),
			"none",
		),
		/**
		 * Whether the demonstrated failure is the defect the reporter described
		 * (through any faithful path), as opposed to an adjacent finding.
		 */
		demonstratedReportedIssue: v.optional(v.boolean(), false),
		/**
		 * Root cause identified without a confirming reproduction (environment
		 * limits, browser-only path). With reproduced=false this reports the
		 * distinct `diagnosed` verdict rather than `not_reproduced`.
		 */
		rootCauseFound: v.optional(v.boolean(), false),
		fixed: v.optional(v.boolean()),
		verdict: v.optional(v.picklist(["bug", "intended-behavior", "unclear"])),
		summary: v.pipe(v.string(), v.minLength(10), v.maxLength(RESULT_SUMMARY_LIMIT)),
		failureStage: v.optional(v.picklist(["workspace", "verification", "publication", "reporting"])),
		/** Reproduction screenshots pushed to bot/artifacts-<n>, rendered in the ask comment. */
		screenshots: v.optional(v.array(screenshotSchema)),
	}),
	v.check(
		(result) =>
			result.reproduced !== true ||
			(result.demonstration !== "none" && result.demonstratedReportedIssue === true),
		"reproduced=true requires demonstration != 'none' and demonstratedReportedIssue=true. If you demonstrated something other than the reported issue, or nothing, set reproduced=false and describe the finding in summary.",
	),
);

const implementationResultSchema = v.object({
	skipped: v.optional(v.boolean()),
	implemented: v.boolean(),
	summary: v.pipe(v.string(), v.minLength(10), v.maxLength(RESULT_SUMMARY_LIMIT)),
	failureStage: v.optional(v.picklist(["workspace", "verification", "publication", "reporting"])),
	screenshots: v.optional(v.array(screenshotSchema)),
});

const publicationSchema = v.object({
	branch: v.string(),
	commitSha: v.string(),
	files: v.array(v.string()),
});

const verificationRecordSchema = v.object({
	name: v.string(),
	command: v.string(),
	exitCode: v.number(),
	candidateTreeSha: v.string(),
});

const reportedResultSchema = v.object({
	result: v.union([resultSchema, implementationResultSchema]),
	ok: v.boolean(),
	pushed: v.boolean(),
	runId: v.string(),
	publication: v.nullable(publicationSchema),
	verification: v.array(verificationRecordSchema),
});

type InvestigateData = v.InferOutput<typeof initialDataSchema>;
type InvestigationResult = v.InferOutput<typeof resultSchema>;
type ImplementationResult = v.InferOutput<typeof implementationResultSchema>;

interface RunFailure {
	stage: "workspace" | "verification" | "publication" | "reporting";
	message: string;
}

export function Investigate({ id }: AgentProps) {
	const input = useInitialData<InvestigateData>();
	const [setupComplete, setSetupComplete] = usePersistentState("setup-complete", false);
	const [reported, setReported] = usePersistentState("reported", false);
	const [reminded, setReminded] = usePersistentState("report-reminded", false);
	const [publication, setPublication] = usePersistentState<CandidatePublication | null>(
		"publication",
		null,
	);
	const [verification, setVerification] = usePersistentState<VerificationRecord[]>(
		"verification",
		[],
	);
	const [lastFailure, setLastFailure] = usePersistentState<RunFailure | null>("last-failure", null);
	const writeResult = useDataWriter("investigation", { schema: reportedResultSchema });
	const env = execEnvFor(id, input);

	useModel("cloudflare/@cf/moonshotai/kimi-k2.7-code");

	if (input.mode === "implement") {
		useSkill(implementSkill);
	} else {
		useSkill(investigateSkill);
		useSkill(diagnoseSkill);
		useSkill(verifySkill);
		useSkill(reproApiSkill);
		useSkill(reproAdminSkill);
		useSkill(reproPublicSkill);
	}
	if (input.mode !== "diagnose" && input.mode !== "implement") {
		useSkill(fixSkill);
	}

	useAgentStart(async ({ log }) => {
		if (setupComplete || reported) return;
		try {
			await env.ensureRepo({ dir: REPO_DIR, ref: cloneRef(input) });
			setSetupComplete(true);
		} catch (error) {
			setLastFailure({ stage: "workspace", message: safeFailureMessage(error) });
			const result = failedResult(
				`I couldn't prepare the investigation workspace: ${errorMessage(error)}`,
				"workspace",
			);
			await applyInvestigationResult(input, result, false, false);
			writeResult({
				result,
				ok: false,
				pushed: false,
				runId: input.runId,
				publication: null,
				verification: [],
			});
			setReported(true);
			log.error("workspace setup failed", { error: errorMessage(error) });
		}
	});

	useTool(
		defineTool({
			name: "read_file",
			description:
				"Read a file from the workspace (VFS). Prefer this over shelling out to `cat`. Large files truncate; pass offset (1-based start line) and limit (line count) to read a specific range.",
			input: v.object({
				path: v.string(),
				offset: v.optional(v.pipe(v.number(), v.minValue(1))),
				limit: v.optional(v.pipe(v.number(), v.minValue(1))),
			}),
			async run({ data }) {
				const content = await env.readFile(data.path);
				if (data.offset === undefined && data.limit === undefined) {
					return truncateToolResult(content);
				}
				const lines = content.split("\n");
				const start = (data.offset ?? 1) - 1;
				const slice = lines.slice(start, data.limit === undefined ? undefined : start + data.limit);
				return truncateToolResult(
					`[lines ${start + 1}-${start + slice.length} of ${lines.length}]\n${slice.join("\n")}`,
				);
			},
		}),
	);

	useTool(
		defineTool({
			name: "write_file",
			description: "Write (create or overwrite) a file in the workspace.",
			input: v.object({ path: v.string(), content: v.string() }),
			async run({ data }) {
				await env.writeFile(data.path, data.content);
				return `wrote ${data.path}`;
			},
		}),
	);

	useTool(
		defineTool({
			name: "edit_file",
			description: "Replace an exact, unique substring in a file.",
			input: v.object({ path: v.string(), oldString: v.string(), newString: v.string() }),
			async run({ data }) {
				await env.edit(data.path, data.oldString, data.newString);
				return `edited ${data.path}`;
			},
		}),
	);

	useTool(
		defineTool({
			name: "ls",
			description: "List a directory in the workspace.",
			input: v.object({ path: v.string() }),
			async run({ data }) {
				const entries = await env.ls(data.path);
				return truncateToolResult(
					entries.map((e) => (e.type === "directory" ? `${e.name}/` : e.name)).join("\n"),
				);
			},
		}),
	);

	useTool(
		defineTool({
			name: "grep",
			description: "Search the workspace for a pattern. Fast; runs in the isolate.",
			input: v.object({
				pattern: v.string(),
				path: v.string(),
				ignoreCase: v.optional(v.boolean()),
			}),
			async run({ data }) {
				const matches = await env.grep(
					data.pattern,
					data.path,
					data.ignoreCase === undefined ? undefined : { ignoreCase: data.ignoreCase },
				);
				return truncateToolResult(
					matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") || "(no matches)",
				);
			},
		}),
	);

	useTool(
		defineTool({
			name: "exec",
			description:
				"Run a shell command in the Linux container (git, pnpm, astro, vitest, agent-browser). Attaching the container is slow; prefer the VFS tools and `code` for reads and searches, and use exec only to run the project or its toolchain.",
			input: v.object({
				command: v.string(),
				cwd: v.optional(v.string()),
				timeoutMs: v.optional(v.number()),
			}),
			async run({ data }) {
				const result = await env.exec(data.command, {
					...(data.cwd ? { cwd: data.cwd } : {}),
					...(data.timeoutMs ? { timeoutMs: data.timeoutMs } : {}),
				});
				return truncateToolResult(
					[`exit ${result.exitCode}`, result.stdout, result.stderr].filter(Boolean).join("\n"),
				);
			},
		}),
	);

	useTool(
		defineTool({
			name: "code",
			description: buildCodeToolDescription(),
			input: v.object({
				code: v.pipe(v.string(), v.minLength(1)),
			}),
			async run({ data }) {
				const { executor, provider } = codeRuntimeFor(id);
				const { result, error, logs } = await executor.execute(data.code, [provider]);
				if (error) {
					const logsTail = logs?.length ? `\n\nlogs:\n${logs.join("\n")}` : "";
					throw new Error(`code tool failed: ${error}${logsTail}`);
				}
				const resultText = formatCodeResult(result);
				return truncateToolResult(
					logs?.length ? `${resultText}\n\n--- logs ---\n${logs.join("\n")}` : resultText,
				);
			},
		}),
	);

	if (input.mode !== "diagnose") {
		useTool(
			defineTool({
				name: "run_check",
				description:
					"Run a required read-only verification command and bind its real exit status to the exact candidate tree. The command must not modify source files; use edit_file/write_file for changes and check-only formatter commands. Do not add output pipelines or success fallbacks; the tool rejects them. Reuse a stable name such as test, lint, typecheck, or format when rerunning a check after a fix. Rerun every required check after any source change.",
				input: v.object({
					name: v.pipe(v.string(), v.minLength(1), v.maxLength(40)),
					command: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
					cwd: v.optional(v.string()),
					timeoutMs: v.optional(v.number()),
				}),
				async run({ data }) {
					let result: ExecResult;
					let candidateTreeSha: string;
					try {
						assertVerificationCommand(data.command);
						({ result, candidateTreeSha } = await env.runCheck(data.command, {
							...(data.cwd ? { cwd: data.cwd } : {}),
							...(data.timeoutMs ? { timeoutMs: data.timeoutMs } : {}),
						}));
					} catch (error) {
						setLastFailure({ stage: "verification", message: safeFailureMessage(error) });
						throw error;
					}
					const record = {
						name: data.name,
						command: data.command,
						exitCode: result.exitCode,
						candidateTreeSha,
					} satisfies VerificationRecord;
					setVerification((current) => [...current, record]);
					if (result.exitCode !== 0) {
						setLastFailure({
							stage: "verification",
							message: `${data.name} failed with exit ${result.exitCode}`,
						});
					}
					return truncateToolResult(
						[`exit ${result.exitCode}`, result.stdout, result.stderr].filter(Boolean).join("\n"),
					);
				},
			}),
		);

		useTool(
			defineTool({
				name: "publish_candidate",
				description:
					"Publish the verified working tree to this issue's candidate branch. The trusted Worker snapshots the changes, creates the Git objects, updates only bot/fix-<issue>, and verifies the remote SHA. Do not run git commit or git push yourself.",
				input: v.object({
					commitMessage: v.pipe(v.string(), v.minLength(5), v.maxLength(200)),
				}),
				output: publicationSchema,
				durable: true,
				async run({ data, step }) {
					try {
						passingVerificationRecords(verification);
					} catch (error) {
						setLastFailure({ stage: "verification", message: safeFailureMessage(error) });
						throw error;
					}
					let snapshot: CandidateSnapshot;
					try {
						snapshot = await env.snapshotCandidate();
					} catch (error) {
						setLastFailure({ stage: "publication", message: safeFailureMessage(error) });
						throw error;
					}
					try {
						passingVerificationRecords(verification, snapshot.treeSha);
					} catch (error) {
						setLastFailure({ stage: "verification", message: safeFailureMessage(error) });
						throw error;
					}
					try {
						const published = await step.do("publish-candidate", () =>
							publishCandidateForRun(input, data.commitMessage, snapshot),
						);
						setPublication(published);
						setLastFailure(null);
						return { output: published };
					} catch (error) {
						setLastFailure({ stage: "publication", message: safeFailureMessage(error) });
						throw error;
					}
				},
			}),
		);
	}

	if (input.mode === "implement") {
		useTool(
			defineTool({
				name: "report_implementation",
				description:
					"Report the implementation outcome. Set implemented=true only after publish_candidate succeeds. The Worker attaches authoritative verification and publication details.",
				input: implementationResultSchema,
				output: reportedResultSchema,
				durable: true,
				async run({ data, step, log }) {
					requireCandidatePublication(data.implemented, publication);
					const pushed = await step.do("verify-publication", () =>
						detectPublication(input.issueNumber, publication),
					);
					const failure =
						data.implemented && !pushed
							? (lastFailure ?? {
									stage: "publication" as const,
									message: "The candidate branch could not be verified at its published commit.",
								})
							: lastFailure;
					const result = withRunFailure(data, failure);
					await step.do("apply-agent-result", () =>
						applyInvestigationResult(input, result, true, pushed),
					);
					const reportedResult = reportPayload(
						input.runId,
						result,
						pushed,
						publication,
						verification,
					);
					writeResult(reportedResult);
					setReported(true);
					log.info("implementation reported", {
						runId: input.runId,
						issueNumber: input.issueNumber,
						pushed,
					});
					return { output: reportedResult };
				},
			}),
		);
	} else {
		useTool(
			defineTool({
				name: "report_result",
				description:
					"Report the final structured investigation result to the issue orchestrator. reproduced=true means you demonstrated the defect the reporter described, in this checkout. The demonstration does NOT need to copy their exact steps: a failing unit test that exercises the same defect a UI report describes is a full reproduction of the issue -- report it as one, without hedging. It must be the same defect, though: an adjacent or latent bug you demonstrated, an out-of-repo infrastructure symptom, or a root cause from reading code alone is not a reproduction. Three distinct non-reproduced outcomes -- pick the honest one: rootCauseFound=true when you identified the reporter's defect but could not confirm it with a demonstration (environment limits, browser-only path) -- this is a first-class 'diagnosed' verdict; plain reproduced=false when you investigated and found nothing wrong or a different/adjacent issue (describe findings in summary); verdict='unclear' when the issue lacks the information an attempt would need -- say what is missing. Fill demonstration and demonstratedReportedIssue truthfully. If demonstration attempts are not converging after a couple of angles, stop and report the diagnosis with rootCauseFound rather than grinding.",
				input: resultSchema,
				output: reportedResultSchema,
				durable: true,
				async run({ data, step, log }) {
					requireCandidatePublication(data.fixed === true, publication);
					const pushed = await step.do("verify-publication", () =>
						detectPublication(input.issueNumber, publication),
					);
					const failure =
						data.fixed && !pushed
							? (lastFailure ?? {
									stage: "publication" as const,
									message: "The candidate branch could not be verified at its published commit.",
								})
							: lastFailure;
					const result = withRunFailure(data, failure);
					await step.do("apply-agent-result", () =>
						applyInvestigationResult(input, result, true, pushed),
					);
					const reportedResult = reportPayload(
						input.runId,
						result,
						pushed,
						publication,
						verification,
					);
					writeResult(reportedResult);
					setReported(true);
					log.info("investigation reported", {
						runId: input.runId,
						issueNumber: input.issueNumber,
						pushed,
					});
					return { output: reportedResult };
				},
			}),
		);
	}

	useAgentFinish(async ({ response, append, log }) => {
		const reportTool = input.mode === "implement" ? "report_implementation" : "report_result";
		const reportCall = response.toolCalls.some((call) => call.tool === reportTool && !call.isError);
		if (reported || reportCall) return;
		if (!reminded) {
			setReminded(true);
			append({
				kind: "signal",
				type: "investigation.report-required",
				body: `You have not reported the result. Call ${reportTool} now with your final findings. Do not do more investigation.`,
			});
			return;
		}

		const result = failedResult(
			"I couldn't complete this run because the agent stopped without reporting a result.",
			"reporting",
		);
		await applyInvestigationResult(input, result, false, false);
		writeResult({
			result,
			ok: false,
			pushed: false,
			runId: input.runId,
			publication,
			verification,
		});
		setReported(true);
		log.warn("agent stopped without reporting", { runId: input.runId });
	});

	if (reported && !setupComplete) {
		return "Workspace setup failed and the failure has already been reported. Briefly acknowledge that the run could not start.";
	}

	return buildPrompt(input);
}

Investigate.agentName = "investigate";
Investigate.initialData = initialDataSchema;
Investigate.durability = { maxAttempts: 5, timeoutMs: 30 * 60_000 };

/**
 * Per-run ExecEnv, cached on `globalThis` so it survives the agent's re-renders
 * within one isolate (Vite duplicates modules across SSR chunks, so a plain
 * module `let` would not be shared). The container is attached lazily on first
 * container exec; the VFS/isolate side needs no attach.
 */
const EXEC_ENV_REGISTRY = Symbol.for("emdash-bot.execEnvs");

function execEnvRegistry(): Map<string, ExecEnv> {
	const store = globalThis as typeof globalThis & { [EXEC_ENV_REGISTRY]?: Map<string, ExecEnv> };
	return (store[EXEC_ENV_REGISTRY] ??= new Map());
}

function execEnvFor(id: string, input: InvestigateData): ExecEnv {
	const registry = execEnvRegistry();
	const existing = registry.get(id);
	if (existing) return existing;
	const env = new ExecEnv({
		state: new FileSystemStateBackend(new WorkspaceFileSystem(agentWorkspace(id))),
		attachContainer: () => attachContainer(id, input),
		hydrateRepo: (dir, ref) => hydrateWorkspace(id, dir, ref),
		deadlines: DEADLINES,
		repoDir: REPO_DIR,
	});
	registry.set(id, env);
	return env;
}

/**
 * The agent's VFS: a @cloudflare/shell Workspace in this agent DO's own
 * SQLite, spilling large files to R2 under the agent id. Same-id
 * constructions must pass identical options -- the Workspace fingerprints
 * them per (sql, name).
 */
function agentWorkspace(name: string): Workspace {
	const context = getCloudflareContext();
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Flue exposes the DO's SqlStorage behind a narrowed structural type.
	const sql = context.storage.sql as SqlStorage;
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Flue types env as Record<string, unknown>.
	const env = context.env as unknown as Env;
	return new Workspace({ sql, name, ...(env.BOT_WORKSPACE ? { r2: env.BOT_WORKSPACE } : {}) });
}

async function hydrateWorkspace(id: string, dir: string, ref: string): Promise<void> {
	const repo = readRepoContext(workerEnv);
	if (!repo) throw new Error("repository context is not configured");
	const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/tarball/${encodeURIComponent(ref)}`;
	const response = await fetch(url, {
		headers: { "User-Agent": "emdash-bot", Accept: "application/vnd.github+json" },
	});
	if (!response.ok || !response.body) {
		throw new Error(`tarball fetch failed: ${response.status}`);
	}
	await untarInto(
		agentWorkspace(id),
		response.body.pipeThrough(new DecompressionStream("gzip")),
		dir,
	);
}

interface CodeRuntime {
	executor: DynamicWorkerExecutor;
	provider: ResolvedProvider;
}

const CODE_RUNTIME_REGISTRY = Symbol.for("emdash-bot.codeRuntimes");

function codeRuntimeFor(id: string): CodeRuntime {
	const store = globalThis as typeof globalThis & {
		[CODE_RUNTIME_REGISTRY]?: Map<string, CodeRuntime>;
	};
	const registry = (store[CODE_RUNTIME_REGISTRY] ??= new Map());
	const existing = registry.get(id);
	if (existing) return existing;
	const runtime: CodeRuntime = {
		executor: new DynamicWorkerExecutor({ loader: workerEnv.LOADER }),
		provider: resolveProvider(
			stateToolsFromBackend(
				readOnlyState(new FileSystemStateBackend(new WorkspaceFileSystem(agentWorkspace(id)))),
			),
		),
	};
	registry.set(id, runtime);
	return runtime;
}

const READ_STATE_METHODS: ReadonlySet<string> = new Set([
	"getCapabilities",
	"readFile",
	"readFileBytes",
	"readJson",
	"exists",
	"stat",
	"readdir",
	"readdirWithFileTypes",
	"find",
	"walkTree",
	"summarizeTree",
	"searchText",
	"searchFiles",
	"glob",
	"diff",
	"diffContent",
	"readlink",
	"realpath",
	"resolvePath",
]);

/**
 * The code tool is an analysis surface: expose only reading and searching.
 * Edits must flow through the write_file/edit_file tools so the change log
 * that drives container materialization sees them.
 */
function readOnlyState(backend: FileSystemStateBackend): StateBackend {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- delegating by method name over the backend's own surface.
	const surface = backend as unknown as Record<string, (...a: unknown[]) => unknown>;
	const wrapped: Record<string, unknown> = {};
	for (const method of Object.keys(STATE_METHODS)) {
		wrapped[method] = READ_STATE_METHODS.has(method)
			? (...args: unknown[]) => surface[method]?.(...args)
			: () => {
					throw new Error(
						`state.${method} is disabled in the code tool; use the write_file/edit_file tools to change files`,
					);
				};
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- structurally covers every STATE_METHODS entry.
	return wrapped as unknown as StateBackend;
}

function formatCodeResult(result: unknown): string {
	if (result === undefined) return "(no result)";
	if (typeof result === "string") return result;
	if (typeof result === "bigint") return result.toString();
	try {
		return JSON.stringify(result, null, 2);
	} catch {
		return "[unserializable result]";
	}
}

function buildCodeToolDescription(): string {
	return [
		"Run a snippet of JavaScript in an isolated Worker against the workspace",
		"filesystem, for search and analysis. The snippet must be a single async",
		"arrow function:",
		"",
		"  async () => {",
		'    const hits = await state.searchFiles("/workspace/repo/**/*.ts", "TODO");',
		"    return hits.length;",
		"  }",
		"",
		"Rules:",
		"- Write JavaScript, not TypeScript. No `import` statements; everything is on `state`.",
		"- Always `return` the value you want back — keep it small (counts, paths,",
		"  short excerpts), not whole files. Network access is disabled.",
		"- The state surface is READ-ONLY here: write methods throw. Change files",
		"  with the write_file/edit_file tools instead.",
		"",
		"Available `state` methods (all async):",
		"- readFile(path) / readFileBytes(path) / readJson(path)",
		"- exists(path) / stat(path) / readlink(path) / realpath(path) / resolvePath(base, path)",
		"- readdir(path) / readdirWithFileTypes(path) / find(path, opts) / glob(pattern)",
		"- walkTree(path, opts) / summarizeTree(path, opts)",
		"- searchText(path, query, { regex?, caseSensitive?, maxMatches?, contextBefore?, contextAfter? })",
		"- searchFiles(globPattern, query, opts) -> [{ path, matches: [{ line, lineText }] }]",
		"- diff(pathA, pathB) / diffContent(path, newContent)",
	].join("\n");
}

/**
 * Attach the container substrate and reproduce the base checkout the toolchain
 * runs against: git identity, a clone (or fetch) at the run's ref, and the
 * issue-scoped push capability the outbound proxy verifies. pnpm install is
 * left to the repro/fix skills -- isolate-first, container work on demand.
 */
async function attachContainer(id: string, input: InvestigateData): Promise<ContainerBackend> {
	const container = fromSandbox(getSandbox(workerEnv.Sandbox, id));
	const repo = readRepoContext(workerEnv);
	if (!repo) throw new Error("repository context is not configured");
	const ref = cloneRef(input);
	// Diagnose mode is investigation-only: no push capability enters the
	// container, so a fix push is impossible rather than merely instructed against.
	const pushCapability =
		input.mode === "diagnose"
			? null
			: await createPushCapability(
					workerEnv.GITHUB_WEBHOOK_SECRET,
					repo.owner,
					repo.repo,
					input.issueNumber,
				);
	// Fetch the target ref and detach onto FETCH_HEAD. This resolves a branch,
	// a tag, or a bare commit SHA the same way, so an eval run pinned to a
	// fixing PR's pre-fix commit checks out just like a normal branch run.
	const steps: Array<{ command: string; timeoutMs?: number }> = [
		{ command: 'git config --global user.email "emdashbot[bot]@users.noreply.github.com"' },
		{ command: 'git config --global user.name "emdashbot[bot]"' },
		{ command: "mkdir -p /workspace" },
		{
			command: `if [ ! -d ${REPO_DIR}/.git ]; then git clone --depth ${CLONE_DEPTH} ${quote(cloneUrl())} ${REPO_DIR}; fi`,
			timeoutMs: 5 * 60_000,
		},
		{
			command: `cd ${REPO_DIR} && git fetch --depth ${CLONE_DEPTH} origin ${quote(ref)} && git checkout --detach FETCH_HEAD`,
			timeoutMs: 5 * 60_000,
		},
		...(pushCapability
			? [
					{
						command: `cd ${REPO_DIR} && git config http.https://github.com/.extraHeader ${quote(`${PUSH_CAPABILITY_HEADER}: ${pushCapability}`)}`,
					},
				]
			: []),
	];
	for (const step of steps) {
		const result = await container.exec(step.command, {
			cwd: "/",
			...(step.timeoutMs ? { timeoutMs: step.timeoutMs } : {}),
		});
		if (result.exitCode !== 0) {
			throw new Error(`container setup failed (${result.exitCode}): ${result.stderr.slice(-500)}`);
		}
	}
	return container;
}

function cloneUrl(): string {
	const repo = readRepoContext(workerEnv);
	if (!repo) throw new Error("repository context is not configured");
	return `https://github.com/${repo.owner}/${repo.repo}.git`;
}

function cloneRef(input: InvestigateData): string {
	if (input.baseRef) return input.baseRef;
	return input.mode === "revise" ? `bot/fix-${input.issueNumber}` : "main";
}

function failedResult(summary: string, failureStage?: RunFailure["stage"]): InvestigationResult {
	return {
		summary: truncateSummary(summary),
		fixed: false,
		reproduced: false,
		demonstration: "none",
		demonstratedReportedIssue: false,
		rootCauseFound: false,
		verdict: "unclear",
		...(failureStage ? { failureStage } : {}),
	};
}

function truncateSummary(text: string): string {
	return text.length <= RESULT_SUMMARY_LIMIT ? text : `${text.slice(0, RESULT_SUMMARY_LIMIT - 1)}…`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function detectPublication(
	issueNumber: number,
	publication: CandidatePublication | null,
): Promise<boolean> {
	if (!publication) return false;
	const repo = readRepoContext(workerEnv);
	const creds = readAppCreds(workerEnv);
	if (!repo || !creds) return false;
	try {
		const token = await mintInstallationToken(creds);
		const currentBranchSha = await getBranchSha(token, repo, `bot/fix-${issueNumber}`);
		return currentBranchSha === publication.commitSha;
	} catch (error) {
		console.warn("[investigate] publication verification failed", { error: errorMessage(error) });
		return false;
	}
}

async function publishCandidateForRun(
	input: InvestigateData,
	commitMessage: string,
	snapshot: CandidateSnapshot,
): Promise<CandidatePublication> {
	const repo = readRepoContext(workerEnv);
	const creds = readAppCreds(workerEnv);
	if (!repo || !creds) throw new Error("GitHub App credentials or repository context missing");
	const token = await mintInstallationToken(creds);
	return publishCandidate(
		{
			branch: `bot/fix-${input.issueNumber}`,
			runId: input.runId,
			commitMessage,
			expectedPreviousSha: input.previousBranchSha,
			snapshot,
		},
		candidateGitHub(token, repo),
	);
}

function candidateGitHub(
	token: string,
	repo: NonNullable<ReturnType<typeof readRepoContext>>,
): CandidateGitHub {
	return {
		getBranchSha: (branch) => getBranchSha(token, repo, branch),
		getCommit: (sha) => getGitCommit(token, repo, sha),
		createBlob: (content) => createGitBlob(token, repo, content),
		createTree: (baseTreeSha, entries) => createGitTree(token, repo, baseTreeSha, entries),
		createCommit: (message, treeSha, parentSha) =>
			createGitCommit(token, repo, message, treeSha, parentSha),
		createBranch: (branch, commitSha) => createBranch(token, repo, branch, commitSha),
		updateBranch: (branch, commitSha) => updateBranch(token, repo, branch, commitSha),
	};
}

function reportPayload(
	runId: string,
	result: InvestigationResult | ImplementationResult,
	pushed: boolean,
	publication: CandidatePublication | null,
	verification: readonly VerificationRecord[],
) {
	return {
		result,
		ok: true,
		pushed,
		runId,
		publication,
		verification: [...verification],
	};
}

function withRunFailure<T extends InvestigationResult | ImplementationResult>(
	result: T,
	failure: RunFailure | null,
): T & { failureStage?: RunFailure["stage"] } {
	if (!failure) return result;
	return {
		...result,
		failureStage: failure.stage,
		summary: truncateSummary(`${result.summary}\n\n${failure.message}`),
	};
}

function safeFailureMessage(error: unknown): string {
	return errorMessage(error)
		.replaceAll(/[\r\n]+/g, " ")
		.slice(0, 500);
}

function buildPrompt(input: InvestigateData): string {
	const argSection = input.arg ? ["", "## Directive", "", input.arg, ""].join("\n") : "";
	const diagnose = input.mode === "diagnose";
	const implement = input.mode === "implement";
	const method = diagnose
		? [
				"- Read AGENTS.md, find the relevant code, and attempt to reproduce the bug.",
				"- Diagnose the root cause. Do NOT write or push a fix -- this is investigation only.",
				"- Report `reproduced` and put the diagnosis in `summary`. Use verdict `unclear` only when you are blocked on information that only the reporter can supply.",
			]
		: implement
			? [
					"- Read AGENTS.md and implement the requested change directly; this mode has no bug-reproduction gate.",
					"- Edit with edit_file/write_file. Use exec for exploration only and run every required final check with run_check.",
					"- After all latest named checks pass, call publish_candidate with the commit message. Do not run git commit or git push.",
					"- Call report_implementation exactly once. implemented=true is valid only after publish_candidate succeeds.",
				]
			: [
					"- Read AGENTS.md, find the relevant code, attempt to reproduce, build, or revise.",
					"- Write tests where they make sense.",
					"- Touch only files relevant to the issue. Do not bulk-format or modify .github/workflows.",
					"- Run every required final check with run_check; output pipelines and success fallbacks are rejected.",
					"- When the change is verified, call publish_candidate. Do not run git commit or git push yourself.",
					`- Reproduction screenshots may still be pushed only to \`bot/artifacts-${input.issueNumber}\`; keep \`.bot-artifacts/\` off the candidate branch and report each screenshot's basename and description.`,
				];
	const closing = diagnose
		? "Call report_result exactly once when finished. Do not set fixed; report reproduced and your verdict with the diagnosis in summary."
		: implement
			? "Call report_implementation exactly once when finished."
			: "Call report_result exactly once when finished. fixed may only be true if the fix passed verification and publish_candidate succeeded.";
	return [
		`Investigate issue #${input.issueNumber} in mode: ${input.mode}.`,
		"",
		"The repo is cloned at /workspace/repo. Read AGENTS.md before making changes.",
		"",
		`# ${input.issueTitle}`,
		"",
		input.issueBody || "(no body)",
		argSection,
		"## Method",
		"",
		...method,
		"",
		closing,
	].join("\n");
}
