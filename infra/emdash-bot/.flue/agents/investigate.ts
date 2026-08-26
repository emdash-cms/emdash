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
	useDelivery,
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
	requireCandidatePublication,
	type CandidatePublication,
} from "../lib/candidate-publisher.js";
import { contextRegistry } from "../lib/context-registry.js";
import { type ContainerBackend, ExecEnv, fromSandbox, quote } from "../lib/exec-env.js";
import { createPushCapability, githubPushUrl } from "../lib/github-proxy.js";
import {
	getBranchSha,
	mintInstallationToken,
	readAppCreds,
	readRepoContext,
} from "../lib/github.js";
import {
	applyInvestigationResult,
	prepareWorkPlanComment,
	recordInvestigationProgress,
	recordWorkPlan,
} from "../lib/investigation-result.js";
import { flushAgentTraceWrites } from "../lib/observer.js";
import {
	CONTAINER_PREPARE_TIMEOUT_MS,
	FLUE_RUN_TIMEOUT_MS,
	SANDBOX_SLEEP_AFTER_SECONDS,
} from "../lib/run-policy.js";
import { withDeadline } from "../lib/sandbox-deadline.js";
import { buildTimeoutSummaryPrompt, isTimeoutSummaryDelivery } from "../lib/timeout-recovery.js";
import { untarInto } from "../lib/untar.js";
import { updateWorkPlan, type WorkPlan } from "../lib/work-plan.js";
import {
	attachWorkspaceWithRetry,
	prepareWorkspaceBeforeModel,
	WORKSPACE_SANDBOX_ATTEMPT_LIMIT,
} from "../lib/workspace-attachment.js";
import { bootstrapWorkspace, type WorkspaceBootstrapStage } from "../lib/workspace-bootstrap.js";
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
const CONTAINER_ATTACH_TIMEOUT_MS = CONTAINER_PREPARE_TIMEOUT_MS;
const EXEC_GRACE_MS = 30_000;
const CLONE_DEPTH = 50;
const DEADLINES = {
	defaultTimeoutMs: DEFAULT_RPC_TIMEOUT_MS,
	attachTimeoutMs: CONTAINER_ATTACH_TIMEOUT_MS,
	execGraceMs: EXEC_GRACE_MS,
};
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
	context: v.optional(v.string()),
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

const pullRequestSchema = v.object({
	title: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
	description: v.pipe(v.string(), v.minLength(10), v.maxLength(RESULT_SUMMARY_LIMIT)),
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
		pullRequest: v.optional(pullRequestSchema),
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
	v.check(
		(result) => result.fixed !== true || result.pullRequest !== undefined,
		"fixed=true requires pullRequest with a reviewer-facing title and description.",
	),
);

const implementationResultSchema = v.pipe(
	v.object({
		skipped: v.optional(v.boolean()),
		implemented: v.boolean(),
		summary: v.pipe(v.string(), v.minLength(10), v.maxLength(RESULT_SUMMARY_LIMIT)),
		pullRequest: v.optional(pullRequestSchema),
		failureStage: v.optional(v.picklist(["workspace", "verification", "publication", "reporting"])),
		screenshots: v.optional(v.array(screenshotSchema)),
	}),
	v.check(
		(result) => result.implemented !== true || result.pullRequest !== undefined,
		"implemented=true requires pullRequest with a reviewer-facing title and description.",
	),
);

const publicationSchema = v.object({
	branch: v.string(),
	commitSha: v.string(),
	files: v.array(v.string()),
});

const verificationRecordSchema = v.object({
	name: v.string(),
	command: v.string(),
	cwd: v.optional(v.string()),
	exitCode: v.number(),
	candidateTreeSha: v.string(),
});

const workPlanInputSchema = v.object({
	summary: v.pipe(v.string(), v.minLength(1), v.maxLength(240)),
	steps: v.pipe(
		v.array(
			v.object({
				id: v.pipe(v.string(), v.minLength(1), v.maxLength(40)),
				title: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
				status: v.picklist(["pending", "in_progress", "completed", "blocked", "skipped"]),
			}),
		),
		v.minLength(1),
		v.maxLength(8),
	),
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
	const delivery = useDelivery();
	const [setupComplete, setSetupComplete] = usePersistentState("setup-complete", false);
	const [reported, setReported] = usePersistentState("reported", false);
	const [reminded, setReminded] = usePersistentState("report-reminded", false);
	const [publication, setPublication] = usePersistentState<CandidatePublication | null>(
		"publication",
		null,
	);
	const [lastFailure, setLastFailure] = usePersistentState<RunFailure | null>("last-failure", null);
	const [workPlan, setWorkPlan] = usePersistentState<WorkPlan | null>("work-plan", null);
	const [workspaceSandboxAttempt, setWorkspaceSandboxAttempt] = usePersistentState(
		"workspace-sandbox-attempt",
		0,
	);
	const writeResult = useDataWriter("investigation", { schema: reportedResultSchema });

	useModel("cloudflare/@cf/moonshotai/kimi-k2.7-code");
	if (isTimeoutSummaryDelivery(delivery)) {
		return buildTimeoutSummaryPrompt({ mode: input.mode, lastFailure });
	}

	const env = execEnvFor(id, input, workspaceSandboxAttempt, setWorkspaceSandboxAttempt);

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
		await prepareWorkspaceBeforeModel({
			prepare: async () => {
				await prepareWorkPlanComment(input);
				await env.ensureRepo({ dir: REPO_DIR, ref: cloneRef(input) });
				await env.ensureContainerReady();
				setSetupComplete(true);
				await recordInvestigationProgress(input, {
					kind: "workspace_ready",
					title: "Workspace ready",
					detail: `Checked out ${cloneRef(input)} and restored the investigation workspace`,
				});
			},
			onFailure: async (error) => {
				await recordInvestigationProgress(input, {
					kind: "workspace_failed",
					title: "Workspace setup failed",
					detail: "The investigation workspace could not be prepared",
				});
				const result = failedResult(
					`I couldn't prepare the investigation workspace: ${errorMessage(error)}`,
					"workspace",
				);
				await applyInvestigationResult(input, result, false, false);
				log.error("workspace setup failed", { error: errorMessage(error) });
			},
		});
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
				"Run a read-only shell command in the Linux container (git, pnpm, astro, vitest, agent-browser). Attaching the container is slow; prefer the VFS tools and `code` for reads and searches. Commands that change tracked source are reverted and rejected; change source with edit_file/write_file.",
			input: v.object({
				command: v.string(),
				cwd: v.optional(v.string()),
				timeoutMs: v.optional(v.number()),
			}),
			async run({ data }) {
				const result = await env.execReadOnly(data.command, {
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

	useTool(
		defineTool({
			name: "update_work_plan",
			description:
				"Create or update the public task-specific plan for this run. Call this before substantial work, keep stable step ids, mark exactly one current step in_progress, and update statuses as work advances. Completed and skipped steps remain in history.",
			input: workPlanInputSchema,
			async run({ data }) {
				const next = updateWorkPlan(workPlan, data, Date.now());
				if (!(await recordWorkPlan(input, next))) {
					throw new Error("work plan update was rejected because this run is no longer active");
				}
				setWorkPlan(next);
				return `updated public work plan with ${next.steps.length} steps`;
			},
		}),
	);

	if (input.mode !== "diagnose") {
		useTool(
			defineTool({
				name: "publish_candidate",
				description:
					"Commit and publish the current durable workspace to this issue's candidate branch. Run the relevant tests, typecheck, lint, and format checks with exec first and report their outcomes honestly, but verification failures do not block publication. The scoped Git proxy permits updates only to this issue's bot branches.",
				input: v.object({
					commitMessage: v.pipe(v.string(), v.minLength(5), v.maxLength(200)),
				}),
				output: publicationSchema,
				durable: true,
				async run({ data, step }) {
					await recordInvestigationProgress(input, {
						kind: "candidate_publishing",
						title: "Publishing candidate",
						detail: `Preparing bot/fix-${input.issueNumber} from the current candidate`,
					});
					try {
						const published = await step.do("publish-candidate", () =>
							env.publishCandidate({
								branch: `bot/fix-${input.issueNumber}`,
								runId: input.runId,
								commitMessage: data.commitMessage,
								baseRef: cloneRef(input),
								expectedPreviousSha: input.previousBranchSha,
							}),
						);
						setPublication(published);
						setLastFailure(null);
						await recordInvestigationProgress(input, {
							kind: "candidate_published",
							title: "Candidate published",
							detail: `Published bot/fix-${input.issueNumber} for preview`,
						});
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
					"Report the implementation outcome. Set implemented=true only after publish_candidate succeeds. Include the commands run and any verification failures in the summary. When implemented=true, provide pullRequest with a concise reviewer-facing title and description.",
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
					const reportedResult = reportPayload(input.runId, result, pushed, publication);
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
					"Report the final structured investigation result to the issue orchestrator. reproduced=true means you demonstrated the defect the reporter described, in this checkout. The demonstration does NOT need to copy their exact steps: a failing unit test that exercises the same defect a UI report describes is a full reproduction of the issue -- report it as one, without hedging. It must be the same defect, though: an adjacent or latent bug you demonstrated, an out-of-repo infrastructure symptom, or a root cause from reading code alone is not a reproduction. Three distinct non-reproduced outcomes -- pick the honest one: rootCauseFound=true when you identified the reporter's defect but could not confirm it with a demonstration (environment limits, browser-only path) -- this is a first-class 'diagnosed' verdict; plain reproduced=false when you investigated and found nothing wrong or a different/adjacent issue (describe findings in summary); verdict='unclear' when the issue lacks the information an attempt would need -- say what is missing. Fill demonstration and demonstratedReportedIssue truthfully. If demonstration attempts are not converging after a couple of angles, stop and report the diagnosis with rootCauseFound rather than grinding. When fixed=true, provide pullRequest with a concise reviewer-facing title and description.",
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
					const reportedResult = reportPayload(input.runId, result, pushed, publication);
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
			verification: [],
		});
		setReported(true);
		log.warn("agent stopped without reporting", { runId: input.runId });
	});

	useAgentFinish(async () => {
		await flushAgentTraceWrites(id);
	});

	if (reported && !setupComplete) {
		return "Workspace setup failed and the failure has already been reported. Briefly acknowledge that the run could not start.";
	}

	return buildPrompt(input);
}

Investigate.agentName = "investigate";
Investigate.initialData = initialDataSchema;
Investigate.durability = { maxAttempts: 5, timeoutMs: FLUE_RUN_TIMEOUT_MS };

/**
 * Per-run ExecEnv, cached within the current Durable Object context so it
 * survives agent rerenders without carrying I/O-bound state into a resumed
 * submission running in another context.
 */
const EXEC_ENV_REGISTRY = "emdash-bot.execEnvs";

interface ExecEnvEntry {
	readonly env: ExecEnv;
	readonly sandboxAttempt: { current: number };
}

function execEnvRegistry(): Map<string, ExecEnvEntry> {
	return contextRegistry<ExecEnvEntry>(EXEC_ENV_REGISTRY, getCloudflareContext().storage);
}

function execEnvFor(
	id: string,
	input: InvestigateData,
	workspaceSandboxAttempt: number,
	setWorkspaceSandboxAttempt: (attempt: number) => void,
): ExecEnv {
	const registry = execEnvRegistry();
	const existing = registry.get(id);
	if (existing) {
		existing.sandboxAttempt.current = workspaceSandboxAttempt;
		return existing.env;
	}
	const sandboxAttempt = { current: workspaceSandboxAttempt };
	const env = new ExecEnv({
		state: new FileSystemStateBackend(new WorkspaceFileSystem(agentWorkspace(id))),
		attachContainer: () =>
			attachContainer(id, input, sandboxAttempt.current, (attempt) => {
				sandboxAttempt.current = attempt;
				setWorkspaceSandboxAttempt(attempt);
			}),
		hydrateRepo: (dir, ref) => hydrateWorkspace(id, dir, ref),
		deadlines: DEADLINES,
		repoDir: REPO_DIR,
	});
	registry.set(id, { env, sandboxAttempt });
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
		signal: AbortSignal.timeout(DEFAULT_RPC_TIMEOUT_MS),
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

const CODE_RUNTIME_REGISTRY = "emdash-bot.codeRuntimes";

function codeRuntimeFor(id: string): CodeRuntime {
	const registry = contextRegistry<CodeRuntime>(
		CODE_RUNTIME_REGISTRY,
		getCloudflareContext().storage,
	);
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
 * issue-scoped push capability the outbound proxy verifies. The harness then
 * installs dependencies when needed and creates the base workspace build.
 */
async function attachContainer(
	id: string,
	input: InvestigateData,
	startAttempt: number,
	onAttached: (attempt: number) => void,
): Promise<ContainerBackend> {
	return attachWorkspaceWithRetry({
		agentId: id,
		startAttempt,
		attach: ({ sandboxId }) => attachContainerAttempt(sandboxId, input),
		discard: async ({ sandboxId }) => {
			await withDeadline(
				workspaceSandbox(sandboxId).destroy(),
				DEFAULT_RPC_TIMEOUT_MS,
				"failed sandbox cleanup",
			);
		},
		onDiscardFailure: async ({ sandboxId, discardError }) => {
			console.warn("[investigate] failed sandbox cleanup", {
				sandboxId,
				error: errorMessage(discardError),
			});
		},
		onRetry: async ({ attempt, error }) => {
			console.warn("[investigate] retrying workspace on a fresh sandbox", {
				runId: input.runId,
				attempt: attempt + 1,
				error: errorMessage(error),
			});
			await recordInvestigationProgress(input, {
				kind: "workspace_installing",
				title: "Retrying workspace preparation",
				detail: `Starting a fresh sandbox after a transient platform failure (${attempt + 1}/${WORKSPACE_SANDBOX_ATTEMPT_LIMIT})`,
			});
		},
		onAttached: async ({ attempt }) => {
			onAttached(attempt);
		},
	});
}

async function attachContainerAttempt(
	id: string,
	input: InvestigateData,
): Promise<ContainerBackend> {
	const container = fromSandbox(workspaceSandbox(id));
	await prepareContainer(container, input);
	await bootstrapWorkspace(container, {
		repoDir: REPO_DIR,
		onProgress: async (stage) => {
			await recordBootstrapProgress(input, stage);
		},
	});
	return {
		...container,
		async isReady() {
			const result = await container.exec(
				`git -C ${quote(REPO_DIR)} rev-parse --is-inside-work-tree`,
				{ cwd: "/", timeoutMs: DEFAULT_RPC_TIMEOUT_MS },
			);
			return result.exitCode === 0 && result.stdout.trim() === "true";
		},
	};
}

function workspaceSandbox(id: string) {
	return getSandbox(workerEnv.Sandbox, id, { sleepAfter: SANDBOX_SLEEP_AFTER_SECONDS });
}

async function recordBootstrapProgress(
	input: InvestigateData,
	stage: WorkspaceBootstrapStage,
): Promise<void> {
	await recordInvestigationProgress(input, {
		kind: stage,
		title: stage === "workspace_installing" ? "Installing dependencies" : "Building workspace",
		detail:
			stage === "workspace_installing"
				? "Preparing the repository dependency graph"
				: "Creating the base package build outputs",
	});
}

async function prepareContainer(
	container: ContainerBackend,
	input: InvestigateData,
): Promise<void> {
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
						command: `cd ${REPO_DIR} && git remote set-url --push origin ${quote(githubPushUrl(repo.owner, repo.repo, pushCapability))}`,
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

function reportPayload(
	runId: string,
	result: InvestigationResult | ImplementationResult,
	pushed: boolean,
	publication: CandidatePublication | null,
) {
	return {
		result,
		ok: true,
		pushed,
		runId,
		publication,
		verification: [],
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
	const contextSection = input.context ? ["", input.context, ""].join("\n") : argSection;
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
					"- The candidate is the deliverable. Use one focused test through existing infrastructure; do not build a custom test harness or inspect dependencies merely to improve test coverage.",
					"- If a test approach fails three times or consumes about ten minutes, switch to a lower-level seam. Preserve the final fifteen minutes for metadata, checks, publication, and reporting.",
					"- Edit with edit_file/write_file. Use exec to run the focused tests, affected typecheck, lint, and format check once on the final candidate.",
					"- Fix relevant failures when practical. A remaining check failure does not block publication: call publish_candidate, then report the failure accurately so CI can confirm it.",
					"- Call report_implementation exactly once. implemented=true is valid only after publish_candidate succeeds.",
				]
			: [
					"- Read AGENTS.md, find the relevant code, attempt to reproduce, build, or revise.",
					"- Follow the mode skill's test budget. Use existing test infrastructure and do not build a harness solely for verification.",
					"- Touch only files relevant to the issue. Do not bulk-format or modify .github/workflows.",
					"- Use exec to run focused verification once on the final candidate. Do not hide failures; fix relevant ones when practical and report any that remain.",
					"- Call publish_candidate even when a check remains failing so the candidate and CI evidence are not lost. Do not run git commit or git push yourself.",
					`- Reproduction screenshots may still be pushed only to \`bot/artifacts-${input.issueNumber}\`; keep \`.bot-artifacts/\` off the candidate branch and report each screenshot's basename and description.`,
				];
	const closing = diagnose
		? "Call report_result exactly once when finished. Do not set fixed; report reproduced and your verdict with the diagnosis in summary."
		: implement
			? "Call report_implementation exactly once when finished."
			: "Call report_result exactly once when finished. fixed may only be true after publish_candidate succeeds; report verification outcomes honestly in the summary.";
	return [
		`Investigate issue #${input.issueNumber} in mode: ${input.mode}.`,
		"",
		"The repo is cloned at /workspace/repo. Read AGENTS.md before making changes.",
		"",
		`# ${input.issueTitle}`,
		"",
		input.issueBody || "(no body)",
		contextSection,
		"## Method",
		"",
		"- Create a concise task-specific plan with update_work_plan before substantial work. Update it whenever the active step or scope changes, and finish every step as completed, skipped, or blocked before reporting.",
		...method,
		"",
		closing,
	].join("\n");
}
