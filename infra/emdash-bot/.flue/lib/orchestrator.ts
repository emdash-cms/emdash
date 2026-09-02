// Per-issue Orchestrator Durable Object.
//
// One instance per anchoring issue (`idFromName("issue-" + number)`). Holds
// the canonical state for that issue's bot lifecycle. Labels on GitHub are a
// projection of this state, not the source of truth.

import { dispatch, init } from "@flue/runtime";
import { DurableObject } from "cloudflare:workers";

import { Investigate } from "../agents/investigate.js";
import { classifyComment, type ClassifierInput, type ClassifyResult } from "./classifier-client.js";
import {
	type PullRequestCopy,
	type PreviewScreenshot,
	renderAgentComment,
	renderCommandFeedback,
	renderDraftPrBody,
	renderPullRequestTitle,
	renderPreviewReadyAsk,
	renderReadonlyReply,
	shouldPostReadonlyReply,
} from "./comments.js";
import {
	addLabels,
	closePullRequest,
	createIssueComment,
	createPullRequest,
	deleteBranch,
	findIssueCommentByMarker,
	getBranchSha,
	getIssue,
	getIssueComments,
	getIssueLabels,
	getOpenPullRequest,
	hasIssueCommentMarker,
	mintInstallationToken,
	postIssueComment,
	readAppCreds,
	readRepoContext,
	removeLabels,
	updateIssueComment,
	type RepoContext,
} from "./github.js";
import { investigationBaseRef } from "./investigation-base-ref.js";
import {
	buildIssueContext,
	shouldStoreDiagnosis,
	type StoredDiagnosis,
	type TriggeringComment,
} from "./issue-context.js";
import { STATES, type EventId, type Kind, type StateId } from "./machine.js";
import { branchesToReap, previewUrl, probePreviewReady } from "./preview.js";
import {
	currentState,
	type Decision,
	type InvestigationMode,
	outcomeFromResult,
	resolve,
} from "./router.js";
import {
	advanceRunLifecycle,
	beginRunLifecycle,
	publicRunLifecycle,
	resumeRunLifecycle,
	settleRunLifecycle,
	startRunLifecycle,
	type PublicRunLifecycle,
	type RunLifecycle,
	type RunProgressKind,
} from "./run-lifecycle.js";
import { DEADLINE_WARNING_MESSAGE, runBudgetMs, runSchedule } from "./run-policy.js";
import {
	parseStoredRunTraceEvent,
	RUN_TRACE_EVENT_LIMIT,
	RUN_TRACE_PAGE_LIMIT,
	type PublicRunTraceEvent,
	type PublicRunTracePage,
	type PublicRunTraceSummary,
	type RunTraceEventInput,
} from "./run-trace.js";
import { DeadlineExceededError, withDeadline } from "./sandbox-deadline.js";
import {
	normalizeTimeoutSummary,
	RESUME_SIGNAL_TYPE,
	resumeStateForMode,
	TIMEOUT_SUMMARY_SIGNAL_TYPE,
	TIMEOUT_SUMMARY_TIMEOUT_MS,
} from "./timeout-recovery.js";
import {
	renderPreparingWorkPlanComment,
	renderWorkPlanComment,
	updateWorkPlan as applyWorkPlanUpdate,
	type WorkCommentStatus,
	type WorkPlan,
	type WorkPlanInput,
} from "./work-plan.js";

/**
 * Inert states cannot be advanced by a late-arriving agent result. If a run
 * lands here, the issue was reset, declined, or hand-taken since it started;
 * discard the result rather than re-animate a dead lifecycle.
 */
const INERT_STATES: ReadonlySet<StateId> = new Set<StateId>([
	"unmanaged",
	"triage",
	"declined",
	"done",
	"human_owned",
]);

/**
 * Bounded event log for debugging and replay. Older entries are pruned beyond
 * this limit to keep DO storage costs predictable. Replay never needs the
 * full history -- two weeks of activity on the busiest issue is plenty.
 */
const EVENT_LOG_LIMIT = 200;
const PUBLIC_PROGRESS_LIMIT = 100;
const WORK_COMMENT_LIMIT = 12;
const DASHBOARD_ORIGIN = "https://bot.emdashcms.com";

/**
 * The actor classification the webhook handler resolves before calling
 * `event()`. The router enforces per-event actor lists, but the orchestrator
 * doesn't classify -- that's the webhook's job (sender → maintainer / reporter
 * / system based on App permissions and issue ownership).
 */
export type Actor = "maintainer" | "reporter" | "system" | "other";

/**
 * Normalized webhook event delivered to the DO. The webhook layer turns raw
 * GitHub payloads into one of these before dispatching. `needsClassify` is
 * true for free-text comments that bypassed the deterministic verb path;
 * `event` is null in that case and the classifier resolves it.
 */
export interface NormalizedEvent {
	/** Deterministic event id, if known. Null when the classifier must decide. */
	readonly event: EventId | null;
	/** Free-text arg for arg-carrying events (implement/revise/decline). */
	readonly arg: string | null;
	/** Resolved actor role. */
	readonly actor: Actor;
	/** Current GitHub labels at webhook time -- a projection, not the truth. */
	readonly labels: readonly string[];
	/** True iff the comment is a free-text mention with no bare verb. */
	readonly needsClassify: boolean;
	/** Raw mention text, for the classifier prompt. */
	readonly classifyText?: string | null;
	/** Exact human comment that caused this event, retained for agent context. */
	readonly triggeringComment?: TriggeringComment;
	/** True only on a bot-authored PR (enables the in_review default). */
	readonly allowDefault?: boolean;
	/** Webhook delivery id; the DO dedupes by this. */
	readonly deliveryId?: string;
	/** Issue/PR number for GitHub API side effects. Required for transitions. */
	readonly anchorNumber?: number;
	/**
	 * Skip GitHub side effects (labels, comments, PR ops) and the LLM call.
	 * The sandbox setup still runs so the clone/auth path can be verified.
	 * Workflow returns immediately after setup with a synthetic result.
	 */
	readonly dryRun?: boolean;
	/** Agent's structured summary, surfaced in the post-run comment. */
	readonly agentSummary?: string;
	/** Durable run metadata appended to failed comments for operational lookup. */
	readonly agentRunId?: string;
	readonly agentFailureStage?: string;
	/** Reproduction screenshots the fix run pushed, carried into the ask comment. */
	readonly agentScreenshots?: readonly PreviewScreenshot[];
	/** Reviewer-facing copy carried through preview confirmation into the draft PR. */
	readonly agentPullRequest?: PullRequestCopy;
	/**
	 * Precomposed comment body that replaces the default `renderComment` output
	 * for this transition. Used for the preview-ready ask, whose body needs data
	 * (install URL, screenshots, reporter login) the generic renderer lacks.
	 */
	readonly commentBodyOverride?: string;
	/**
	 * Post the comment BEFORE flipping labels for this transition. The fix-loop
	 * ask must land first: a failed comment post must not leave the issue labeled
	 * awaiting-reporter with no ask for the reporter to act on.
	 */
	readonly commentFirst?: boolean;
	/** Internal callback metadata: this event's projection completes the run. */
	readonly settlesRunId?: string;
	/** Delivery consumed with an internally synthesized recovery transition. */
	readonly settlesDeliveryId?: string;
}

/**
 * Agent return shape we care about. The router's `outcomeFromResult` does the
 * actual mapping; this is just the structural contract.
 */
export interface AgentResult {
	readonly skipped?: boolean;
	readonly reproduced?: boolean;
	readonly rootCauseFound?: boolean;
	readonly fixed?: boolean;
	readonly implemented?: boolean;
	readonly verdict?: string;
	readonly summary?: string;
	readonly pullRequest?: PullRequestCopy;
	readonly failureStage?: string;
	readonly screenshots?: readonly PreviewScreenshot[];
	readonly [key: string]: unknown;
}

/**
 * Persisted DO state. All fields are nullable until the first transition; the
 * orchestrator treats absence as "unmanaged", matching `currentState([])`.
 */
interface PersistedState {
	state: StateId | null;
	kind: Kind | null;
	/** In-flight investigate run. Late results from other run ids are dropped. */
	currentRunId: string | null;
	/** Flue 2 agent instance handling the current run. */
	currentAgentId: string | null;
	/** Flue 2 delivery id returned after durable admission. */
	currentDispatchId: string | null;
	/** Open bot PR for this issue, if any. */
	prNumber: number | null;
}

interface EventLogEntry {
	readonly t: number;
	readonly event: EventId;
	readonly actor: Actor;
	readonly from: StateId | "conflicting" | null;
	readonly to: StateId | null;
	readonly deliveryId?: string;
}

export type PublicProgressKind = RunProgressKind;

export interface PublicProgressEntry {
	readonly t: number;
	readonly kind: PublicProgressKind;
	readonly title: string;
	readonly detail: string | null;
	readonly runId: string;
}

export interface PublicIssueSnapshot {
	readonly state: StateId | null;
	readonly kind: Kind | null;
	readonly run: PublicRunLifecycle | null;
	readonly workPlan: WorkPlan | null;
	readonly currentRunStartedAt: number | null;
	readonly prNumber: number | null;
	readonly transitions: ReadonlyArray<{
		readonly t: number;
		readonly event: EventId;
		readonly from: StateId | "conflicting" | null;
		readonly to: StateId | null;
	}>;
	readonly progress: ReadonlyArray<Omit<PublicProgressEntry, "runId">>;
}

interface InboxEntry {
	readonly id: string;
	readonly input: NormalizedEvent;
	readonly attempts?: number;
}

/**
 * Storage keys live in one namespace per DO instance, so we prefix to avoid
 * collisions with anything Flue or the runtime might add.
 */
const STORAGE = {
	state: "o:state",
	kind: "o:kind",
	currentRunId: "o:currentRunId",
	currentRunMode: "o:currentRunMode",
	runLifecycle: "o:runLifecycle",
	failedRunMode: "o:failedRunMode",
	currentRunStartedAt: "o:currentRunStartedAt",
	currentAgentId: "o:currentAgentId",
	currentDispatchId: "o:currentDispatchId",
	currentDispatchError: "o:currentDispatchError",
	currentDispatchAttempt: "o:currentDispatchAttempt",
	abortConfirmedRunId: "o:abortConfirmedRunId",
	prNumber: "o:prNumber",
	eventLog: "o:eventLog",
	seenDeliveries: "o:seenDeliveries",
	anchorNumber: "o:anchorNumber",
	tokenCache: "o:tokenCache",
	lastTickAt: "o:lastTickAt",
	inbox: "o:inbox",
	pendingDispatch: "o:pendingDispatch",
	pendingSideEffects: "o:pendingSideEffects",
	awaitingReporterSince: "o:awaitingReporterSince",
	previewBuildDeadline: "o:previewBuildDeadline",
	previewPollNextAt: "o:previewPollNextAt",
	previewNotes: "o:previewNotes",
	previewScreenshots: "o:previewScreenshots",
	candidatePullRequest: "o:candidatePullRequest",
	lastDiagnosis: "o:lastDiagnosis",
	deadlineWarningSentRunId: "o:deadlineWarningSentRunId",
	deadlineWarningRetryAt: "o:deadlineWarningRetryAt",
	resumableRun: "o:resumableRun",
	pendingResume: "o:pendingResume",
	publicProgress: "o:publicProgress",
	workPlan: "o:workPlan",
	workComments: "o:workComments",
	currentRunDryRun: "o:currentRunDryRun",
} as const;

const TICK_INTERVAL_MS = 60 * 60 * 1000;
/** Reporter-confirmation window for the fix loop. After this, the alarm fires
 * `expire`, which reaps the candidate branch and falls back to `reproduced`. */
const REPORTER_SILENCE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Overall budget for a candidate preview to publish on pkg.pr.new before we
 * give up and fire `preview.failed`. Publishing normally lands within ~60s. */
const PREVIEW_BUILD_TIMEOUT_MS = 10 * 60 * 1000;
/** First poll waits for the push→publish lag; later polls back off to this. */
const PREVIEW_POLL_INITIAL_MS = 45 * 1000;
const PREVIEW_POLL_INTERVAL_MS = 30 * 1000;
const DISPATCH_TIMEOUT_MS = 30_000;
const INBOX_RETRY_MS = 60_000;
const INBOX_BATCH_LIMIT = 10;
const CLASSIFIER_MAX_ATTEMPTS = 3;
const CLASSIFIER_TEXT_LIMIT = 16_000;

function normalizePullRequestCopy(value: unknown): PullRequestCopy | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { title, description } = value as { title?: unknown; description?: unknown };
	if (typeof title !== "string" || typeof description !== "string") return undefined;
	const normalizedTitle = title.trim().replaceAll(/\s+/g, " ");
	const normalizedDescription = description.trim();
	if (!normalizedTitle || !normalizedDescription) return undefined;
	return { title: normalizedTitle, description: normalizedDescription };
}

interface CachedToken {
	token: string;
	/** Unix ms; tokens are valid ~1h, we expire 5m early. */
	expiresAt: number;
}

interface PreparedInvestigation {
	runId: string;
	agentId: string;
	issueNumber: number;
	mode: InvestigationMode;
	arg: string | null;
	issueTitle: string;
	issueBody: string;
	previousBranchSha: string | null;
	context: string;
	baseRef?: string;
}

interface PendingDispatch extends PreparedInvestigation {
	readonly deliveryId?: string;
}

export interface ResumableRunCheckpoint {
	readonly runId: string;
	readonly agentId: string;
	readonly mode: InvestigationMode;
	readonly state: StateId;
	readonly attemptStartedAt: number;
	readonly timedOutAt: number;
	readonly summary: string | null;
}

interface PreparedResume {
	readonly checkpoint: ResumableRunCheckpoint;
	readonly directive: string | null;
	readonly deliveryId?: string;
}

interface PendingResume extends PreparedResume {
	readonly dryRun: boolean;
}

interface PendingSideEffect {
	readonly id: string;
	readonly deliveryId?: string;
	readonly runId?: string;
	readonly settlesRun: boolean;
	readonly anchorNumber: number;
	readonly addLabels: readonly string[];
	readonly removeLabels: readonly string[];
	readonly commentBody: string;
	readonly commentMarker: string;
	readonly commentMayExist: boolean;
	/** Post the comment before flipping labels (fix-loop ask ordering). */
	readonly commentFirst?: boolean;
}

interface StoredWorkPlan {
	readonly runId: string;
	readonly plan: WorkPlan;
}

interface WorkCommentProjection {
	readonly runId: string;
	readonly anchorNumber: number;
	readonly marker: string;
	readonly body: string;
	readonly commentId: number | null;
	readonly commentMayExist: boolean;
	readonly pending: boolean;
}

interface TraceEventRow {
	readonly [key: string]: string | number;
	readonly id: number;
	readonly run_id: string;
	readonly payload: string;
}

/** Bounded delivery-id dedupe window. */
const DELIVERY_DEDUPE_LIMIT = 64;

export class OrchestratorDO extends DurableObject<Env> {
	private operationTail: Promise<void> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		void ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS run_trace_events (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					event_key TEXT NOT NULL UNIQUE,
					run_id TEXT NOT NULL,
					mode TEXT NOT NULL,
					recorded_at INTEGER NOT NULL,
					event_type TEXT NOT NULL,
					payload TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_run_trace_events_run_id_id
					ON run_trace_events (run_id, id);
			`);
		});
	}

	async enqueue(input: NormalizedEvent): Promise<EnqueueOutcome> {
		const { outcome, rearm } = await this.ctx.storage.transaction(async (transaction) => {
			const [seen, inbox] = await Promise.all([
				transaction.get<string[]>(STORAGE.seenDeliveries),
				transaction.get<InboxEntry[]>(STORAGE.inbox),
			]);
			if (
				input.deliveryId &&
				((seen ?? []).includes(input.deliveryId) ||
					(inbox ?? []).some((entry) => entry.input.deliveryId === input.deliveryId))
			) {
				return {
					outcome: { kind: "duplicate", deliveryId: input.deliveryId } as const,
					rearm: (inbox ?? []).some((entry) => entry.input.deliveryId === input.deliveryId),
				};
			}

			const entry = { id: crypto.randomUUID(), input } satisfies InboxEntry;
			await transaction.put(STORAGE.inbox, [...(inbox ?? []), entry]);
			return { outcome: { kind: "admitted", id: entry.id } as const, rearm: true };
		});
		if (rearm) await this.ctx.storage.setAlarm(Date.now());
		return outcome;
	}

	/**
	 * Entry point from the webhook handler. Single-threaded per DO instance,
	 * so concurrent events for the same issue queue here without racing.
	 */
	event(input: NormalizedEvent): Promise<EventOutcome> {
		return this.runExclusive(() => this.processEvent(input));
	}

	private async processEvent(
		input: NormalizedEvent,
		recoverDispatch = true,
	): Promise<EventOutcome> {
		if (input.deliveryId && (await this.isDeliverySeen(input.deliveryId))) {
			return { kind: "duplicate", deliveryId: input.deliveryId };
		}
		const recoveredDeliveryId = recoverDispatch ? await this.recoverRejectedDispatch() : null;
		if (input.deliveryId && recoveredDeliveryId === input.deliveryId) {
			return { kind: "recovered" };
		}
		const resumedDispatch = input.deliveryId
			? await this.resumePendingDispatch(input.deliveryId)
			: false;
		const resumedRun = input.deliveryId ? await this.resumePendingRun(input.deliveryId) : false;
		await this.drainPendingSideEffects();
		if ((resumedDispatch || resumedRun) && input.deliveryId) {
			await this.recordDelivery(input.deliveryId);
			return { kind: "recovered" };
		}
		if (input.deliveryId && (await this.isDeliverySeen(input.deliveryId))) {
			return { kind: "recovered" };
		}
		if (await this.hasPendingSideEffects()) {
			throw new Error("an earlier GitHub projection is still pending");
		}
		if (input.anchorNumber !== undefined) {
			await this.ctx.storage.put(STORAGE.anchorNumber, input.anchorNumber);
		}

		let resolvedEvent: EventId | null = input.event;
		let resolvedArg: string | null = input.arg;
		if (input.needsClassify || resolvedEvent === null) {
			const classifyResult = await this.runClassifier(input);
			if (classifyResult.kind === "error") {
				throw new ClassifierProcessingError(classifyResult.reason);
			}
			if (classifyResult.kind === "noop") {
				await this.postCommandFeedback(input);
				if (input.deliveryId) await this.recordDelivery(input.deliveryId);
				return classifyResult;
			}
			resolvedEvent = classifyResult.event;
			resolvedArg = classifyResult.arg;
		}

		// DO is the source of truth. If we've ever persisted state for this
		// issue, project our state to labels and use those; otherwise fall
		// back to the webhook's snapshot for first-time mentions.
		const persistedLabels = await this.projectLabels();
		const labels = persistedLabels.length > 0 ? persistedLabels : input.labels;
		const [resumableRun, failedRunMode, previousRun] = await Promise.all([
			resolvedEvent === "resume"
				? this.ctx.storage.get<ResumableRunCheckpoint>(STORAGE.resumableRun)
				: null,
			resolvedEvent === "retry"
				? this.ctx.storage.get<InvestigationMode>(STORAGE.failedRunMode)
				: null,
			resolvedEvent === "retry" ? this.ctx.storage.get<RunLifecycle>(STORAGE.runLifecycle) : null,
		]);
		const retryMode =
			previousRun?.status === "failed" || previousRun?.status === "timed_out"
				? previousRun.mode
				: failedRunMode;

		const decision = resolve({
			labels,
			event: resolvedEvent,
			arg: resolvedArg,
			actor: input.actor,
			...(resumableRun ? { resumeState: resumableRun.state } : {}),
			...(retryMode ? { retryMode } : {}),
		});

		if (decision.kind === "noop") {
			await this.postCommandFeedback({ ...input, event: resolvedEvent }, decision.from);
			if (input.deliveryId) await this.recordDelivery(input.deliveryId);
			return { kind: "noop", reason: decision.reason };
		}
		if (decision.kind === "readonly") {
			if (shouldPostReadonlyReply(input.dryRun)) await this.postReadonlyReply(decision, input);
			if (input.deliveryId) await this.recordDelivery(input.deliveryId);
			return { kind: "readonly", state: decision.state, event: decision.event };
		}
		if (resolvedEvent === "resume" && !resumableRun) {
			if (!input.dryRun) await this.postResumeUnavailable(input);
			if (input.deliveryId) await this.recordDelivery(input.deliveryId);
			return { kind: "noop", reason: "no saved timed-out run to resume" };
		}

		let runError: string | null = null;
		let preparedInvestigation: PreparedInvestigation | null = null;
		let preparedResume: PreparedResume | null = null;
		if (decision.action === "investigate.resume" && resumableRun) {
			preparedResume = {
				checkpoint: resumableRun,
				directive: resolvedArg ?? input.arg,
				...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
			};
		} else if (decision.action?.startsWith("investigate.")) {
			const preparation = await this.prepareInvestigation(
				decision,
				resolvedArg ?? input.arg,
				input,
			);
			if (typeof preparation === "string") runError = preparation;
			else preparedInvestigation = preparation;
		}

		if (decision.action && !decision.action.startsWith("investigate.")) {
			runError = await this.runAction(decision);
		}
		if (runError) {
			throw new Error(runError);
		}

		const cancellationRun =
			decision.event === "reset" || decision.event === "decline" || decision.event === "take_over"
				? await this.ctx.storage.get<RunLifecycle>(STORAGE.runLifecycle)
				: null;
		const sideEffectId = await this.persistDecision(
			decision,
			input,
			preparedInvestigation,
			preparedResume,
		);
		if (cancellationRun?.status === "running") {
			await this.finalizeWorkPlanComment({
				runId: cancellationRun.runId,
				status: "cancelled",
				outcome: `Run cancelled by ${decision.event.replaceAll("_", " ")}.`,
			});
		}
		await this.armAlarm();

		if (preparedInvestigation) {
			runError = await this.dispatchInvestigation(preparedInvestigation);
		} else if (preparedResume) {
			runError = await this.dispatchResumedRun(preparedResume, input.dryRun === true);
		} else if (decision.action === "closePr") {
			await this.ctx.storage.delete(STORAGE.prNumber);
		}
		if (runError) throw new Error(runError);

		if (sideEffectId) await this.drainPendingSideEffects();
		await this.armAlarm();
		if (input.deliveryId) await this.recordDelivery(input.deliveryId);
		return {
			kind: "transition",
			decision,
			...(runError ? { runError } : {}),
		};
	}

	/**
	 * Map an investigate run's result to a follow-up machine event.
	 * Late-result discard: if the run id no longer matches the current
	 * in-flight run, the issue was advanced or reset since the run started;
	 * drop the result silently.
	 */
	applyAgentResult(input: {
		runId: string;
		result: AgentResult;
		pushed: boolean;
		ok: boolean;
	}): Promise<EventOutcome> {
		return this.runExclusive(() => this.processAgentResult(input));
	}

	async recordPublicProgress(input: {
		runId: string;
		kind: PublicProgressKind;
		title: string;
		detail?: string | null;
	}): Promise<boolean> {
		const result = await this.ctx.storage.transaction(async (transaction) => {
			if ((await transaction.get<string>(STORAGE.currentRunId)) !== input.runId) {
				return { accepted: false, startedBudget: false };
			}
			const existing = (await transaction.get<PublicProgressEntry[]>(STORAGE.publicProgress)) ?? [];
			const run = await transaction.get<RunLifecycle>(STORAGE.runLifecycle);
			const now = Date.now();
			const entry: PublicProgressEntry = {
				t: now,
				kind: input.kind,
				title: sanitizePublicProgressText(input.title, 80),
				detail: input.detail ? sanitizePublicProgressText(input.detail, 240) : null,
				runId: input.runId,
			};
			const startsBudget =
				input.kind === "workspace_ready" && run?.runId === input.runId && run.phase === "prepare";
			const nextRun =
				run?.runId === input.runId
					? advanceRunLifecycle(startsBudget ? beginRunLifecycle(run, now) : run, input.kind)
					: null;
			await Promise.all([
				transaction.put(STORAGE.publicProgress, [...existing, entry].slice(-PUBLIC_PROGRESS_LIMIT)),
				...(nextRun ? [transaction.put(STORAGE.runLifecycle, nextRun)] : []),
				...(startsBudget ? [transaction.put(STORAGE.currentRunStartedAt, now)] : []),
			]);
			return { accepted: true, startedBudget: startsBudget };
		});
		if (result.startedBudget) {
			await this.armAlarm(true);
		}
		return result.accepted;
	}

	async recordRunTraceEvent(input: { runId: string; event: RunTraceEventInput }): Promise<boolean> {
		const event = parseStoredRunTraceEvent(input.event);
		if (!event) return false;
		const [currentRunId, run, legacyMode] = await Promise.all([
			this.ctx.storage.get<string>(STORAGE.currentRunId),
			this.ctx.storage.get<RunLifecycle>(STORAGE.runLifecycle),
			this.ctx.storage.get<InvestigationMode>(STORAGE.currentRunMode),
		]);
		if (currentRunId !== input.runId && run?.runId !== input.runId) return false;
		const mode = run?.runId === input.runId ? run.mode : legacyMode;
		if (!mode) return false;
		this.ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO run_trace_events
				(event_key, run_id, mode, recorded_at, event_type, payload)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			event.key,
			input.runId,
			mode,
			event.at,
			event.kind,
			JSON.stringify(event),
		);
		this.ctx.storage.sql.exec(
			`DELETE FROM run_trace_events
			 WHERE id <= COALESCE(
				(SELECT id FROM run_trace_events ORDER BY id DESC LIMIT 1 OFFSET ?),
				0
			)`,
			RUN_TRACE_EVENT_LIMIT,
		);
		return true;
	}

	async getPublicRunTrace(
		options: { runId?: string; before?: number; limit?: number } = {},
	): Promise<PublicRunTracePage> {
		const requestedLimit = Number.isFinite(options.limit) ? (options.limit ?? 100) : 100;
		const limit = Math.min(RUN_TRACE_PAGE_LIMIT, Math.max(1, Math.trunc(requestedLimit)));
		const runRows = this.ctx.storage.sql
			.exec<{
				run_id: string;
				mode: string;
				started_at: number;
				updated_at: number;
				event_count: number;
			}>(
				`SELECT run_id, mode, MIN(recorded_at) AS started_at,
					MAX(recorded_at) AS updated_at, COUNT(*) AS event_count
				 FROM run_trace_events
				 GROUP BY run_id, mode
				 ORDER BY updated_at DESC
				 LIMIT 50`,
			)
			.toArray();
		const runs = runRows.flatMap((row): PublicRunTraceSummary[] => {
			const mode = parseInvestigateMode(row.mode);
			if (!mode) return [];
			return [
				{
					runId: row.run_id,
					mode,
					startedAt: row.started_at,
					updatedAt: row.updated_at,
					eventCount: row.event_count,
				},
			];
		});
		const selectedRunId = options.runId ?? runs[0]?.runId ?? null;
		if (!selectedRunId) return { runs, selectedRunId: null, events: [], nextBefore: null };
		const before =
			typeof options.before === "number" &&
			Number.isSafeInteger(options.before) &&
			options.before > 0
				? options.before
				: null;
		const rows = (
			before === null
				? this.ctx.storage.sql.exec<TraceEventRow>(
						`SELECT id, run_id, payload FROM run_trace_events
						 WHERE run_id = ? ORDER BY id DESC LIMIT ?`,
						selectedRunId,
						limit + 1,
					)
				: this.ctx.storage.sql.exec<TraceEventRow>(
						`SELECT id, run_id, payload FROM run_trace_events
						 WHERE run_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
						selectedRunId,
						before,
						limit + 1,
					)
		).toArray();
		const hasMore = rows.length > limit;
		const selectedRows = hasMore ? rows.slice(0, limit) : rows;
		const events = selectedRows
			.flatMap((row): PublicRunTraceEvent[] => {
				try {
					const event = parseStoredRunTraceEvent(JSON.parse(row.payload));
					return event ? [{ ...event, id: row.id, runId: row.run_id }] : [];
				} catch {
					return [];
				}
			})
			.toReversed();
		return {
			runs,
			selectedRunId,
			events,
			nextBefore: hasMore ? (events[0]?.id ?? null) : null,
		};
	}

	async prepareWorkPlanComment(input: { runId: string; summary: string }): Promise<boolean> {
		const result = await this.ctx.storage.transaction(async (transaction) => {
			const [currentRunId, run, storedPlan, comments, anchorNumber, dryRun] = await Promise.all([
				transaction.get<string>(STORAGE.currentRunId),
				transaction.get<RunLifecycle>(STORAGE.runLifecycle),
				transaction.get<StoredWorkPlan>(STORAGE.workPlan),
				transaction.get<WorkCommentProjection[]>(STORAGE.workComments),
				transaction.get<number>(STORAGE.anchorNumber),
				transaction.get<boolean>(STORAGE.currentRunDryRun),
			]);
			if (currentRunId !== input.runId || run?.runId !== input.runId) {
				return { accepted: false, dryRun: true };
			}
			const existingPlan = storedPlan?.runId === input.runId ? storedPlan.plan : null;
			if (existingPlan && existingPlan.steps[0]?.id !== "prepare-workspace") {
				return { accepted: true, dryRun: true };
			}
			if (dryRun) return { accepted: true, dryRun: true };
			if (anchorNumber === undefined) throw new Error("workspace preparation has no issue anchor");
			const plan =
				existingPlan ??
				applyWorkPlanUpdate(
					null,
					{
						summary: input.summary,
						steps: [
							{
								id: "prepare-workspace",
								title: "Install dependencies and build the repository",
								status: "in_progress",
							},
						],
					},
					Date.now(),
				);
			const marker = `<!-- emdashbot-run:${input.runId} -->`;
			const body = `${renderPreparingWorkPlanComment({
				mode: run.mode,
				summary: input.summary,
			})}\n\n[View live dashboard](${DASHBOARD_ORIGIN}/?issue=${anchorNumber}) · Run: \`${input.runId}\``;
			const existing = comments?.find((comment) => comment.runId === input.runId);
			const projection: WorkCommentProjection = existing
				? { ...existing, body, pending: true }
				: {
						runId: input.runId,
						anchorNumber,
						marker,
						body,
						commentId: null,
						commentMayExist: false,
						pending: true,
					};
			await Promise.all([
				transaction.put(STORAGE.workPlan, { runId: input.runId, plan } satisfies StoredWorkPlan),
				transaction.put(
					STORAGE.workComments,
					[
						...(comments ?? []).filter((comment) => comment.runId !== input.runId),
						projection,
					].slice(-WORK_COMMENT_LIMIT),
				),
			]);
			return { accepted: true, dryRun: false };
		});
		if (!result.accepted || result.dryRun) return result.accepted;
		await this.ctx.storage.setAlarm(Date.now());
		await this.flushWorkComment(input.runId);
		return true;
	}

	updateWorkPlan(input: { runId: string } & WorkPlanInput): Promise<boolean> {
		return this.runExclusive(() => this.processWorkPlanUpdate(input));
	}

	private async processWorkPlanUpdate(input: {
		runId: string;
		summary: string;
		steps: WorkPlanInput["steps"];
	}): Promise<boolean> {
		const result = await this.ctx.storage.transaction(async (transaction) => {
			const [currentRunId, run, stored, anchorNumber, dryRun, comments] = await Promise.all([
				transaction.get<string>(STORAGE.currentRunId),
				transaction.get<RunLifecycle>(STORAGE.runLifecycle),
				transaction.get<StoredWorkPlan>(STORAGE.workPlan),
				transaction.get<number>(STORAGE.anchorNumber),
				transaction.get<boolean>(STORAGE.currentRunDryRun),
				transaction.get<WorkCommentProjection[]>(STORAGE.workComments),
			]);
			if (currentRunId !== input.runId || run?.runId !== input.runId) {
				return { accepted: false, dryRun: true };
			}
			if (anchorNumber === undefined) throw new Error("work plan has no issue anchor");
			const previous = stored?.runId === input.runId ? stored.plan : null;
			const plan = applyWorkPlanUpdate(previous, input, Date.now());
			const writes: Promise<unknown>[] = [
				transaction.put(STORAGE.workPlan, {
					runId: input.runId,
					plan,
				} satisfies StoredWorkPlan),
			];
			if (!dryRun) {
				const marker = `<!-- emdashbot-run:${input.runId} -->`;
				const body = `${renderWorkPlanComment({ plan, mode: run.mode, status: run.status })}\n\n[View live dashboard](${DASHBOARD_ORIGIN}/?issue=${anchorNumber}) · Run: \`${input.runId}\``;
				const existing = comments?.find((comment) => comment.runId === input.runId);
				const projection: WorkCommentProjection = existing
					? { ...existing, body, pending: true }
					: {
							runId: input.runId,
							anchorNumber,
							marker,
							body,
							commentId: null,
							commentMayExist: false,
							pending: true,
						};
				writes.push(
					transaction.put(
						STORAGE.workComments,
						[
							...(comments ?? []).filter((comment) => comment.runId !== input.runId),
							projection,
						].slice(-WORK_COMMENT_LIMIT),
					),
				);
			}
			await Promise.all(writes);
			return { accepted: true, dryRun: dryRun === true };
		});
		if (!result.accepted) return false;
		if (!result.dryRun) {
			await this.ctx.storage.setAlarm(Date.now());
			try {
				await this.flushWorkComment(input.runId);
			} catch (error) {
				console.error("[orchestrator] work plan comment update failed", {
					runId: input.runId,
					error: errorMessage(error),
				});
			}
		}
		return true;
	}

	private async finalizeWorkPlanComment(input: {
		runId: string;
		status: Exclude<WorkCommentStatus, "running">;
		outcome: string;
	}): Promise<boolean> {
		const result = await this.ctx.storage.transaction(async (transaction) => {
			const [stored, run, comments, anchorNumber, dryRun] = await Promise.all([
				transaction.get<StoredWorkPlan>(STORAGE.workPlan),
				transaction.get<RunLifecycle>(STORAGE.runLifecycle),
				transaction.get<WorkCommentProjection[]>(STORAGE.workComments),
				transaction.get<number>(STORAGE.anchorNumber),
				transaction.get<boolean>(STORAGE.currentRunDryRun),
			]);
			if (stored?.runId !== input.runId || run?.runId !== input.runId) {
				return { found: false, dryRun: true };
			}
			if (dryRun) return { found: true, dryRun: true };
			if (anchorNumber === undefined) throw new Error("work plan has no issue anchor");
			const marker = `<!-- emdashbot-run:${input.runId} -->`;
			const body = `${renderWorkPlanComment({
				plan: stored.plan,
				mode: run.mode,
				status: input.status,
				outcome: input.outcome,
			})}\n\n[View live dashboard](${DASHBOARD_ORIGIN}/?issue=${anchorNumber}) · Run: \`${input.runId}\``;
			const existing = comments?.find((comment) => comment.runId === input.runId);
			const projection: WorkCommentProjection = existing
				? { ...existing, body, pending: true }
				: {
						runId: input.runId,
						anchorNumber,
						marker,
						body,
						commentId: null,
						commentMayExist: false,
						pending: true,
					};
			await transaction.put(
				STORAGE.workComments,
				[...(comments ?? []).filter((comment) => comment.runId !== input.runId), projection].slice(
					-WORK_COMMENT_LIMIT,
				),
			);
			return { found: true, dryRun: false };
		});
		if (!result.found) return false;
		if (result.dryRun) return true;
		await this.ctx.storage.setAlarm(Date.now());
		try {
			await this.flushWorkComment(input.runId);
		} catch (error) {
			console.error("[orchestrator] final work comment update failed", {
				runId: input.runId,
				error: errorMessage(error),
			});
		}
		return true;
	}

	private async processAgentResult(input: {
		runId: string;
		result: AgentResult;
		pushed: boolean;
		ok: boolean;
	}): Promise<EventOutcome> {
		const [currentRunId, legacyRunMode, run, currentAgentId, legacyRunStartedAt] =
			await Promise.all([
				this.ctx.storage.get<string>(STORAGE.currentRunId),
				this.ctx.storage.get<InvestigationMode>(STORAGE.currentRunMode),
				this.ctx.storage.get<RunLifecycle>(STORAGE.runLifecycle),
				this.ctx.storage.get<string>(STORAGE.currentAgentId),
				this.ctx.storage.get<number>(STORAGE.currentRunStartedAt),
			]);
		const currentRunMode = run?.runId === input.runId ? run.mode : legacyRunMode;
		if (currentRunId !== input.runId) {
			return { kind: "stale-run", runId: input.runId, currentRunId: currentRunId ?? null };
		}
		const savedRun = await this.ctx.storage.get<ResumableRunCheckpoint>(STORAGE.resumableRun);
		await this.confirmDispatchAdmission(input.runId);
		const settledRuns = await this.drainPendingSideEffects();
		if (settledRuns.has(input.runId)) return { kind: "recovered" };

		const state = await this.ctx.storage.get<StateId>(STORAGE.state);
		if (state && INERT_STATES.has(state)) {
			await this.clearRun(input.runId);
			return { kind: "inert", state };
		}
		if (currentRunMode && shouldStoreDiagnosis(currentRunMode, input.result, input.ok)) {
			await this.persistSuccessfulDiagnosis(input.runId, currentRunMode, input.result);
		}

		const event = outcomeFromResult({
			ok: input.ok,
			result: input.result,
			pushed: input.pushed,
			mode: currentRunMode,
		});
		const resumedAttempt = savedRun?.runId === input.runId || (run?.attempt ?? 1) > 1;
		if (event === "agent.failed" && resumedAttempt && currentRunMode && currentAgentId && state) {
			await this.ctx.storage.put<ResumableRunCheckpoint>(STORAGE.resumableRun, {
				runId: input.runId,
				agentId: currentAgentId,
				mode: currentRunMode,
				state,
				attemptStartedAt: run?.startedAt ?? legacyRunStartedAt ?? Date.now(),
				timedOutAt: Date.now(),
				summary: input.result.summary ?? savedRun?.summary ?? null,
			});
		} else if (savedRun?.runId === input.runId) {
			await this.ctx.storage.delete(STORAGE.resumableRun);
		}

		const labels = await this.projectLabels();
		const agentSummary =
			typeof input.result?.summary === "string" ? input.result.summary : undefined;
		const agentPullRequest = normalizePullRequestCopy(input.result.pullRequest);
		const runStatus: Exclude<WorkCommentStatus, "running"> =
			event === "agent.failed"
				? input.result.failureStage === "timeout"
					? "timed_out"
					: "failed"
				: event === "agent.needs_info" ||
					  event === "agent.skipped" ||
					  (event === "agent.reproduced" && currentRunMode !== "diagnose")
					? "needs_follow_up"
					: "succeeded";
		const failureStage =
			typeof input.result.failureStage === "string" ? input.result.failureStage : null;
		const finalizedWorkComment = await this.finalizeWorkPlanComment({
			runId: input.runId,
			status: runStatus,
			outcome: `${agentSummary ?? "The run completed without a summary."}${failureStage ? `\n\nFailed stage: ${failureStage}` : ""}`,
		});
		const agentScreenshots = Array.isArray(input.result?.screenshots)
			? input.result.screenshots
			: undefined;
		const outcome = await this.processEvent({
			event,
			arg: null,
			actor: "system",
			labels,
			needsClassify: false,
			settlesRunId: input.runId,
			agentRunId: input.runId,
			...(agentSummary ? { agentSummary } : {}),
			...(agentPullRequest ? { agentPullRequest } : {}),
			...(finalizedWorkComment ? { commentBodyOverride: "" } : {}),
			...(failureStage ? { agentFailureStage: failureStage } : {}),
			...(agentScreenshots ? { agentScreenshots } : {}),
		});
		await this.clearRun(input.runId);
		return outcome;
	}

	/**
	 * Reap the fix loop's branches when the anchoring issue closes: always
	 * delete bot/artifacts-<n>, delete bot/fix-<n> only when no open PR
	 * references it. Does not touch machine state -- a closed issue may
	 * legitimately keep its in_review/PR state, and the branches are a
	 * projection we clean up regardless.
	 */
	cleanupOnClose(anchorNumber: number): Promise<CleanupOutcome> {
		return this.runExclusive(() => this.processCleanupOnClose(anchorNumber));
	}

	private async processCleanupOnClose(anchorNumber: number): Promise<CleanupOutcome> {
		await this.ctx.storage.put(STORAGE.anchorNumber, anchorNumber);
		const creds = readAppCreds(this.env);
		const repo = readRepoContext(this.env);
		if (!creds || !repo) return { kind: "skipped", reason: "credentials or repository missing" };
		const error = await this.runReapBranch(creds, repo, anchorNumber);
		return error ? { kind: "error", error } : { kind: "reaped" };
	}

	/**
	 * Periodic recovery, fired by the DO's own alarm. Drops stale runs and
	 * re-projects DO state onto GitHub labels (resilient to manual edits).
	 * The alarm self-arms; first arming happens via `armAlarm()` in event().
	 */
	tick(): Promise<TickOutcome> {
		return this.runExclusive(() => this.processTick());
	}

	private async processTick(): Promise<TickOutcome> {
		const now = Date.now();
		await this.ctx.storage.put(STORAGE.lastTickAt, now);

		let processedInboxItem = false;
		let inboxError: string | null = null;
		for (let count = 0; count < INBOX_BATCH_LIMIT; count += 1) {
			try {
				await this.drainPendingSideEffects();
				const processed = await this.processInboxHead();
				if (!processed) break;
				processedInboxItem = true;
			} catch (error) {
				inboxError = error instanceof Error ? error.message : String(error);
				console.error("[orchestrator] inbox processing failed", { error: inboxError });
				break;
			}
		}
		let recoveryError: string | null = null;
		try {
			await this.drainPendingWorkComments();
		} catch (error) {
			recoveryError = errorMessage(error);
			console.error("[orchestrator] work comment recovery failed", {
				error: recoveryError,
			});
		}
		let sentDeadlineWarning = false;
		try {
			sentDeadlineWarning = await this.sendDeadlineWarningIfDue(now);
		} catch (error) {
			recoveryError = errorMessage(error);
			await this.ctx.storage.put(STORAGE.deadlineWarningRetryAt, now + INBOX_RETRY_MS);
			console.error("[orchestrator] deadline warning delivery failed", {
				error: recoveryError,
			});
		}
		let droppedStaleRun = false;
		try {
			await this.recoverRejectedDispatch();
			droppedStaleRun = await this.recoverStaleRun(now);
		} catch (error) {
			recoveryError = error instanceof Error ? error.message : String(error);
			console.error("[orchestrator] stale-run recovery failed", { error: recoveryError });
		}
		let expiredReporterWait = false;
		try {
			expiredReporterWait = await this.reapExpiredReporterWait(now);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			recoveryError ??= message;
			console.error("[orchestrator] reporter-wait expiry failed", { error: message });
		}
		let previewPoll: PreviewPollOutcome = "idle";
		try {
			previewPoll = await this.pollPreviewBuild(now);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			recoveryError ??= message;
			console.error("[orchestrator] preview poll failed", { error: message });
		}
		const labelDrift = await this.reconcileLabels();

		return {
			ranAt: now,
			processedInboxItem,
			inboxError,
			sentDeadlineWarning,
			droppedStaleRun,
			recoveryError,
			labelDrift,
			expiredReporterWait,
			previewPoll,
		};
	}

	/**
	 * Poll pkg.pr.new for the candidate change's preview while the item sits in
	 * `preview_building`. One probe per alarm tick (the alarm cadence IS the
	 * poll interval -- no unbounded loop in the DO). A 200 fires `preview.ready`
	 * and advances to the reporter ask; exhausting the overall budget fires
	 * `preview.failed`, which retains the branch for inspection.
	 */
	private async pollPreviewBuild(now: number): Promise<PreviewPollOutcome> {
		const [state, deadline, nextAt] = await Promise.all([
			this.ctx.storage.get<StateId>(STORAGE.state),
			this.ctx.storage.get<number>(STORAGE.previewBuildDeadline),
			this.ctx.storage.get<number>(STORAGE.previewPollNextAt),
		]);
		if (state !== "preview_building" || deadline === undefined) return "idle";
		if (nextAt !== undefined && now < nextAt) return "waiting";
		const anchorNumber = await this.ctx.storage.get<number>(STORAGE.anchorNumber);
		if (anchorNumber === undefined) return "idle";

		let candidatePreviewUrl: string;
		try {
			candidatePreviewUrl = previewUrl(anchorNumber, this.env.PREVIEW_PACKAGE);
		} catch (error) {
			console.error("[orchestrator] invalid preview configuration", {
				error: errorMessage(error),
			});
			await this.firePreviewEvent(
				anchorNumber,
				"preview.failed",
				"The preview package configuration is invalid. The candidate branch was retained for inspection.",
			);
			return "failed";
		}

		const ready = await probePreviewReady(candidatePreviewUrl);
		if (ready) {
			await this.firePreviewReady(anchorNumber);
			return "ready";
		}
		if (now >= deadline) {
			await this.firePreviewEvent(anchorNumber, "preview.failed");
			return "failed";
		}
		await this.ctx.storage.put(STORAGE.previewPollNextAt, now + PREVIEW_POLL_INTERVAL_MS);
		return "polling";
	}

	/**
	 * Fire `preview.ready`, composing the ask comment first so it can post ahead
	 * of the label flip. Composition needs the persisted fix notes/screenshots
	 * and the reporter's login; without live creds (dev/tests) we still advance
	 * the state, just without a comment.
	 */
	private async firePreviewReady(anchorNumber: number): Promise<void> {
		const labels = await this.projectLabels();
		const creds = readAppCreds(this.env);
		const repo = readRepoContext(this.env);
		let override: string | undefined;
		if (creds && repo) {
			const [notes, screenshots] = await Promise.all([
				this.ctx.storage.get<string>(STORAGE.previewNotes),
				this.ctx.storage.get<PreviewScreenshot[]>(STORAGE.previewScreenshots),
			]);
			let reporterLogin: string | null = null;
			try {
				const token = await this.getInstallationToken(creds);
				reporterLogin = (await getIssue(token, repo, anchorNumber)).authorLogin;
			} catch (err) {
				console.error("[orchestrator] preview ask: reporter lookup failed", err);
			}
			override = renderPreviewReadyAsk({
				owner: repo.owner,
				repo: repo.repo,
				issueNumber: anchorNumber,
				previewPackage: this.env.PREVIEW_PACKAGE,
				at: new Date().toISOString(),
				notes,
				...(screenshots ? { screenshots } : {}),
				reporterLogin,
			});
		}
		await this.processEvent({
			event: "preview.ready",
			arg: null,
			actor: "system",
			labels,
			needsClassify: false,
			...(override ? { commentBodyOverride: override, commentFirst: true } : {}),
		});
	}

	private async firePreviewEvent(
		anchorNumber: number,
		event: EventId,
		failureComment?: string,
	): Promise<void> {
		const labels = await this.projectLabels();
		const commentBodyOverride =
			event === "preview.failed"
				? (failureComment ??
					`The preview build for the candidate change didn't publish within ${Math.round(PREVIEW_BUILD_TIMEOUT_MS / 60_000)} minutes. The candidate branch was retained for inspection.`)
				: undefined;
		await this.processEvent({
			event,
			arg: null,
			actor: "system",
			labels,
			needsClassify: false,
			anchorNumber,
			...(commentBodyOverride ? { commentBodyOverride } : {}),
		});
	}

	/**
	 * Fire the fix loop's `expire` timer when the reporter has been silent past
	 * the confirmation window. The transition reaps the candidate branch and
	 * falls back to the `reproduced` verdict.
	 */
	private async reapExpiredReporterWait(now: number): Promise<boolean> {
		const [state, since] = await Promise.all([
			this.ctx.storage.get<StateId>(STORAGE.state),
			this.ctx.storage.get<number>(STORAGE.awaitingReporterSince),
		]);
		if (state !== "awaiting_reporter" || since === undefined) return false;
		if (now - since < REPORTER_SILENCE_WINDOW_MS) return false;
		const labels = await this.projectLabels();
		await this.processEvent({
			event: "expire",
			arg: null,
			actor: "system",
			labels,
			needsClassify: false,
		});
		return true;
	}

	private async processInboxHead(): Promise<boolean> {
		const inbox = (await this.ctx.storage.get<InboxEntry[]>(STORAGE.inbox)) ?? [];
		const entry = inbox[0];
		if (!entry) return false;

		try {
			await this.processEvent(entry.input);
		} catch (error) {
			if (!(error instanceof ClassifierProcessingError)) throw error;
			const attempts = (entry.attempts ?? 0) + 1;
			await this.ctx.storage.transaction(async (transaction) => {
				const current = (await transaction.get<InboxEntry[]>(STORAGE.inbox)) ?? [];
				if (current[0]?.id !== entry.id) return;
				if (attempts < CLASSIFIER_MAX_ATTEMPTS) {
					await transaction.put(STORAGE.inbox, [{ ...entry, attempts }, ...current.slice(1)]);
					return;
				}
				if (entry.input.deliveryId) {
					const seen = (await transaction.get<string[]>(STORAGE.seenDeliveries)) ?? [];
					if (!seen.includes(entry.input.deliveryId)) {
						await transaction.put(
							STORAGE.seenDeliveries,
							[...seen, entry.input.deliveryId].slice(-DELIVERY_DEDUPE_LIMIT),
						);
					}
				}
				if (current.length === 1) await transaction.delete(STORAGE.inbox);
				else await transaction.put(STORAGE.inbox, current.slice(1));
			});
			if (attempts >= CLASSIFIER_MAX_ATTEMPTS) {
				console.error("[orchestrator] discarded classifier entry after retry limit", {
					deliveryId: entry.input.deliveryId,
					error: error.message,
				});
				return true;
			}
			throw error;
		}
		await this.ctx.storage.transaction(async (transaction) => {
			const current = (await transaction.get<InboxEntry[]>(STORAGE.inbox)) ?? [];
			if (current[0]?.id !== entry.id) return;
			if (current.length === 1) await transaction.delete(STORAGE.inbox);
			else await transaction.put(STORAGE.inbox, current.slice(1));
		});
		return true;
	}

	/** DO alarm handler. Self-rearms. */
	override async alarm(): Promise<void> {
		try {
			await this.tick();
		} catch (err) {
			console.error("[orchestrator] tick failed:", err);
		}
		await this.armAlarm();
	}

	private async armAlarm(force = false): Promise<void> {
		const [
			current,
			run,
			legacyRunStartedAt,
			legacyRunMode,
			warningSentRunId,
			warningRetryAt,
			currentRunId,
			inbox,
			pendingSideEffects,
			workComments,
			pendingResume,
			previewPollNextAt,
		] = await Promise.all([
			this.ctx.storage.getAlarm(),
			this.ctx.storage.get<RunLifecycle>(STORAGE.runLifecycle),
			this.ctx.storage.get<number>(STORAGE.currentRunStartedAt),
			this.ctx.storage.get<InvestigationMode>(STORAGE.currentRunMode),
			this.ctx.storage.get<string>(STORAGE.deadlineWarningSentRunId),
			this.ctx.storage.get<number>(STORAGE.deadlineWarningRetryAt),
			this.ctx.storage.get<string>(STORAGE.currentRunId),
			this.ctx.storage.get<InboxEntry[]>(STORAGE.inbox),
			this.ctx.storage.get<PendingSideEffect[]>(STORAGE.pendingSideEffects),
			this.ctx.storage.get<WorkCommentProjection[]>(STORAGE.workComments),
			this.ctx.storage.get<PendingResume>(STORAGE.pendingResume),
			this.ctx.storage.get<number>(STORAGE.previewPollNextAt),
		]);
		const now = Date.now();
		const activeRun = run?.status === "running" ? run : null;
		const runStartedAt = activeRun?.startedAt ?? legacyRunStartedAt;
		const runMode = activeRun?.mode ?? legacyRunMode;
		const scheduledRunAlarm = runStartedAt
			? runSchedule(runMode ?? "repro", runStartedAt, warningSentRunId === currentRunId).nextAlarmAt
			: null;
		const runAlarmAt =
			scheduledRunAlarm !== null && warningSentRunId !== currentRunId && warningRetryAt
				? Math.max(scheduledRunAlarm, warningRetryAt)
				: scheduledRunAlarm;
		let desired = now + TICK_INTERVAL_MS;
		if (
			inbox?.length ||
			pendingSideEffects?.length ||
			workComments?.some((comment) => comment.pending) ||
			pendingResume
		) {
			desired = Math.min(desired, now + INBOX_RETRY_MS);
		}
		if (runAlarmAt !== null) {
			desired = Math.min(desired, Math.max(now + 1_000, runAlarmAt));
		}
		if (previewPollNextAt !== undefined) {
			desired = Math.min(desired, Math.max(now + 1_000, previewPollNextAt));
		}
		if (force || current === null || current <= now || current > desired) {
			await this.ctx.storage.setAlarm(desired);
		}
	}

	private async sendDeadlineWarningIfDue(now: number): Promise<boolean> {
		const [runId, agentId, run, legacyMode, legacyStartedAt, warningSentRunId, state] =
			await Promise.all([
				this.ctx.storage.get<string>(STORAGE.currentRunId),
				this.ctx.storage.get<string>(STORAGE.currentAgentId),
				this.ctx.storage.get<RunLifecycle>(STORAGE.runLifecycle),
				this.ctx.storage.get<InvestigationMode>(STORAGE.currentRunMode),
				this.ctx.storage.get<number>(STORAGE.currentRunStartedAt),
				this.ctx.storage.get<string>(STORAGE.deadlineWarningSentRunId),
				this.ctx.storage.get<StateId>(STORAGE.state),
			]);
		const activeRun = run && run.runId === runId && run.status === "running" ? run : null;
		const mode = activeRun?.mode ?? legacyMode;
		const startedAt = activeRun?.startedAt ?? legacyStartedAt;
		if (
			!runId ||
			!agentId ||
			!mode ||
			startedAt === undefined ||
			warningSentRunId === runId ||
			(state !== undefined && INERT_STATES.has(state))
		) {
			return false;
		}
		const schedule = runSchedule(mode, startedAt, false);
		if (schedule.warningAt === null || now < schedule.warningAt || now >= schedule.deadlineAt) {
			return false;
		}

		await this.deliverDeadlineWarning({ agentId, runId, deadlineAt: schedule.deadlineAt });

		return this.ctx.storage.transaction(async (transaction) => {
			if ((await transaction.get<string>(STORAGE.currentRunId)) !== runId) return false;
			await Promise.all([
				transaction.put(STORAGE.deadlineWarningSentRunId, runId),
				transaction.delete(STORAGE.deadlineWarningRetryAt),
			]);
			return true;
		});
	}

	protected async deliverDeadlineWarning(input: {
		agentId: string;
		runId: string;
		deadlineAt: number;
	}): Promise<void> {
		await withDeadline(
			dispatch(Investigate, {
				id: input.agentId,
				idempotencyKey: `deadline-warning:${input.runId}:${input.deadlineAt}`,
				message: {
					kind: "signal",
					type: "investigation.deadline-warning",
					tagName: "deadline-warning",
					attributes: { runId: input.runId, deadlineAt: String(input.deadlineAt) },
					body: DEADLINE_WARNING_MESSAGE,
				},
			}),
			DISPATCH_TIMEOUT_MS,
			"Deadline warning admission",
		);
	}

	private async persistSuccessfulDiagnosis(
		runId: string,
		mode: "diagnose" | "repro",
		result: AgentResult,
	): Promise<void> {
		await this.ctx.storage.transaction(async (transaction) => {
			const existing = await transaction.get<StoredDiagnosis>(STORAGE.lastDiagnosis);
			if (existing?.runId === runId) return;
			await transaction.put<StoredDiagnosis>(STORAGE.lastDiagnosis, {
				runId,
				mode,
				completedAt: new Date().toISOString(),
				result,
			});
		});
	}

	private async requestTimeoutSummary(input: {
		runId: string;
		agentId: string;
		mode: InvestigationMode;
		attemptStartedAt: number;
	}): Promise<string> {
		const handle = init(Investigate, { id: input.agentId });
		let receipt: Awaited<ReturnType<typeof handle.dispatch>>;
		try {
			receipt = await withDeadline(
				handle.dispatch({
					idempotencyKey: `timeout-summary:${input.runId}:${input.attemptStartedAt}`,
					message: {
						kind: "signal",
						type: TIMEOUT_SUMMARY_SIGNAL_TYPE,
						tagName: "timeout-summary",
						attributes: { runId: input.runId, mode: input.mode },
						body: "Execution has stopped. Provide the tool-free timeout checkpoint summary now.",
					},
				}),
				DISPATCH_TIMEOUT_MS,
				"Timeout summary admission",
			);
		} catch (error) {
			console.error("[orchestrator] timeout summary admission failed", {
				runId: input.runId,
				error: errorMessage(error),
			});
			return normalizeTimeoutSummary("");
		}

		try {
			const reply = await handle.read(receipt, {
				signal: AbortSignal.timeout(TIMEOUT_SUMMARY_TIMEOUT_MS),
			});
			return normalizeTimeoutSummary(reply.text);
		} catch (error) {
			console.error("[orchestrator] timeout summary failed", {
				runId: input.runId,
				error: errorMessage(error),
			});
			try {
				await handle.abort();
			} catch (abortError) {
				console.error("[orchestrator] timeout summary abort failed", {
					runId: input.runId,
					error: errorMessage(abortError),
				});
			}
			return normalizeTimeoutSummary("");
		}
	}

	private async recoverStaleRun(now: number): Promise<boolean> {
		const [run, legacyStartedAt, legacyMode, state] = await Promise.all([
			this.ctx.storage.get<RunLifecycle>(STORAGE.runLifecycle),
			this.ctx.storage.get<number>(STORAGE.currentRunStartedAt),
			this.ctx.storage.get<InvestigationMode>(STORAGE.currentRunMode),
			this.ctx.storage.get<StateId>(STORAGE.state),
		]);
		const activeRun = run?.status === "running" ? run : null;
		const startedAt = activeRun?.startedAt ?? legacyStartedAt;
		const mode = activeRun?.mode ?? legacyMode;
		if (startedAt === undefined) return false;
		if (now - startedAt < runBudgetMs(mode ?? "repro")) return false;
		const runId = await this.ctx.storage.get<string>(STORAGE.currentRunId);
		const agentId = await this.ctx.storage.get<string>(STORAGE.currentAgentId);
		const [pendingDispatch, pendingResume] = await Promise.all([
			this.ctx.storage.get<PendingDispatch>(STORAGE.pendingDispatch),
			this.ctx.storage.get<PendingResume>(STORAGE.pendingResume),
		]);
		if (!runId || !agentId) {
			throw new Error("stale run is missing its run or agent identifier");
		}
		console.warn("[orchestrator] dropping stale run", {
			runId,
			agentId,
			startedAt,
			ageMs: now - startedAt,
		});
		const abortConfirmedRunId = await this.ctx.storage.get<string>(STORAGE.abortConfirmedRunId);
		if (abortConfirmedRunId !== runId) {
			await this.abortAgent(agentId);
			await this.ctx.storage.put(STORAGE.abortConfirmedRunId, runId);
		}
		await this.discardLaunchSideEffects(runId);
		const effectiveMode = mode ?? "repro";
		const resumeState =
			state === "working" || state === "investigating" || state === "fixing"
				? state
				: resumeStateForMode(effectiveMode);
		const existing = await this.ctx.storage.get<ResumableRunCheckpoint>(STORAGE.resumableRun);
		let checkpoint: ResumableRunCheckpoint =
			existing?.runId === runId && existing.attemptStartedAt === startedAt
				? existing
				: {
						runId,
						agentId,
						mode: effectiveMode,
						state: resumeState,
						attemptStartedAt: startedAt,
						timedOutAt: now,
						summary: null,
					};
		await this.ctx.storage.put(STORAGE.resumableRun, checkpoint);
		if (checkpoint.summary === null) {
			const summary = await this.requestTimeoutSummary({
				runId,
				agentId,
				mode: effectiveMode,
				attemptStartedAt: startedAt,
			});
			checkpoint = { ...checkpoint, summary };
			await this.ctx.storage.put(STORAGE.resumableRun, checkpoint);
		}
		const deliveryId =
			pendingDispatch?.runId === runId
				? pendingDispatch.deliveryId
				: pendingResume?.checkpoint.runId === runId
					? pendingResume.deliveryId
					: undefined;

		// Commit the failed transition before deleting retry evidence. If this
		// throws, the run markers remain and the next alarm retries recovery.
		const labels = await this.projectLabels();
		const timeoutSummary = `${checkpoint.summary}\n\nThe conversation and workspace are saved. A maintainer can continue them with \`@emdashbot resume\`.`;
		const finalizedWorkComment = await this.finalizeWorkPlanComment({
			runId,
			status: "timed_out",
			outcome: timeoutSummary,
		});
		await this.processEvent({
			event: "agent.failed",
			arg: null,
			actor: "system",
			labels,
			needsClassify: false,
			agentSummary: timeoutSummary,
			...(finalizedWorkComment ? { commentBodyOverride: "" } : {}),
			agentFailureStage: "timeout",
			agentRunId: runId,
			settlesRunId: runId,
			...(deliveryId ? { settlesDeliveryId: deliveryId } : {}),
		});
		await this.clearRun(runId);
		return true;
	}

	private async recoverRejectedDispatch(): Promise<string | null> {
		const [pending, pendingResume, dispatchError] = await Promise.all([
			this.ctx.storage.get<PendingDispatch>(STORAGE.pendingDispatch),
			this.ctx.storage.get<PendingResume>(STORAGE.pendingResume),
			this.ctx.storage.get<string>(STORAGE.currentDispatchError),
		]);
		const runId = pending?.runId ?? pendingResume?.checkpoint.runId;
		if (!runId || !dispatchError) return null;

		await this.discardLaunchSideEffects(runId);
		const labels = await this.projectLabels();
		await this.processEvent(
			{
				event: "agent.failed",
				arg: null,
				actor: "system",
				labels,
				needsClassify: false,
				agentSummary: pendingResume
					? `I couldn't resume the saved run: ${dispatchError}`
					: `I couldn't start this run: ${dispatchError}`,
				settlesRunId: runId,
			},
			false,
		);
		await this.clearRun(runId);
		const deliveryId = pending?.deliveryId ?? pendingResume?.deliveryId;
		if (deliveryId) await this.recordDelivery(deliveryId);
		return deliveryId ?? null;
	}

	private async reconcileLabels(): Promise<{ added: number; removed: number } | null> {
		const [pendingDispatch, pendingSideEffects] = await Promise.all([
			this.ctx.storage.get<PendingDispatch>(STORAGE.pendingDispatch),
			this.ctx.storage.get<PendingSideEffect[]>(STORAGE.pendingSideEffects),
		]);
		if (pendingDispatch || pendingSideEffects?.length) return null;
		const creds = readAppCreds(this.env);
		const repo = readRepoContext(this.env);
		if (!creds || !repo) return null;
		const anchorNumber = await this.ctx.storage.get<number>(STORAGE.anchorNumber);
		if (anchorNumber === undefined) return null;
		const state = await this.ctx.storage.get<StateId>(STORAGE.state);
		const kind = await this.ctx.storage.get<Kind>(STORAGE.kind);
		if (!state) return null;

		const expectedStateLabel = STATES[state].label;
		const expectedLabels = new Set<string>();
		if (expectedStateLabel) expectedLabels.add(expectedStateLabel);
		if (kind) expectedLabels.add(`bot:${kind}`);

		let liveLabels: string[];
		try {
			const token = await this.getInstallationToken(creds);
			liveLabels = await getIssueLabels(token, repo, anchorNumber);
		} catch (err) {
			console.error("[orchestrator] reconcileLabels: getIssueLabels failed:", err);
			return null;
		}

		const liveSet = new Set(liveLabels);
		const allBotLabels = liveLabels.filter((l) => l.startsWith("bot:"));
		const toAdd: string[] = [];
		for (const l of expectedLabels) if (!liveSet.has(l)) toAdd.push(l);
		const toRemove: string[] = allBotLabels.filter((l) => !expectedLabels.has(l));

		if (toAdd.length === 0 && toRemove.length === 0) return { added: 0, removed: 0 };

		try {
			const token = await this.getInstallationToken(creds);
			if (toAdd.length > 0) await addLabels(token, repo, anchorNumber, toAdd);
			if (toRemove.length > 0) await removeLabels(token, repo, anchorNumber, toRemove);
		} catch (err) {
			console.error("[orchestrator] reconcileLabels: label flip failed:", err);
			return null;
		}
		console.log("[orchestrator] reconciled label drift", {
			anchorNumber,
			added: toAdd,
			removed: toRemove,
		});
		return { added: toAdd.length, removed: toRemove.length };
	}

	// ---------------- Classifier ----------------

	private async runClassifier(
		input: NormalizedEvent,
	): Promise<
		| { kind: "noop"; reason: string }
		| { kind: "error"; reason: string }
		| { event: EventId; arg: string | null; kind: "resolved" }
	> {
		const text = (input.classifyText?.trim() ?? "").slice(0, CLASSIFIER_TEXT_LIMIT);
		if (text === "") return { kind: "noop", reason: "no classify text" };
		if (input.anchorNumber === undefined) {
			return { kind: "noop", reason: "no anchor number for classifier call" };
		}
		const persistedState = await this.ctx.storage.get<StateId>(STORAGE.state);
		const state = persistedState ?? currentState(input.labels);
		const result = await this.requestClassification({
			issueNumber: input.anchorNumber,
			state,
			comment: text,
		});
		switch (result.kind) {
			case "no-commands":
				return { kind: "noop", reason: `no commands available from state "${state}"` };
			case "none":
				return { kind: "noop", reason: `classifier: none (${result.reasoning})` };
			case "error":
				console.error("[orchestrator] classifier failed:", result.error);
				return { kind: "error", reason: result.error };
			case "event":
				return { kind: "resolved", event: result.event, arg: result.arg };
		}
	}

	protected requestClassification(input: ClassifierInput): Promise<ClassifyResult> {
		return classifyComment(this.env.AI, input);
	}

	// ---------------- Workflow dispatch ----------------

	/**
	 * Invoke the investigate workflow for a transition that has an action.
	 * Generates a runId, persists it, fetches the issue context from GitHub,
	 * then admits the workflow run. Returns null on success or an error
	 * string. The workflow runs asynchronously and calls back into
	 * applyAgentResult() when complete.
	 */
	private async runAction(
		decision: Extract<Decision, { kind: "transition" }>,
	): Promise<string | null> {
		if (!decision.action) return null;
		const anchorNumber = await this.ctx.storage.get<number>(STORAGE.anchorNumber);
		if (anchorNumber === undefined) return "no anchor number for action dispatch";

		const creds = readAppCreds(this.env);
		const repo = readRepoContext(this.env);
		if (!creds || !repo) {
			console.log("[orchestrator] skipping action dispatch (creds or repo missing)", {
				action: decision.action,
				anchorNumber,
			});
			return import.meta.env.DEV ? null : "GitHub credentials or repository context missing";
		}

		if (decision.action === "openPr") {
			return this.runOpenPr(creds, repo, anchorNumber);
		}
		if (decision.action === "openDraftPr") {
			return this.runOpenPr(creds, repo, anchorNumber, true);
		}
		if (decision.action === "closePr") {
			return this.runClosePr(creds, repo);
		}
		if (decision.action === "reapBranch") {
			return this.runReapBranch(creds, repo, anchorNumber);
		}
		return `unknown action "${decision.action}"`;
	}

	private async prepareInvestigation(
		decision: Extract<Decision, { kind: "transition" }>,
		arg: string | null,
		input: NormalizedEvent,
	): Promise<PreparedInvestigation | string | null> {
		if (!decision.action?.startsWith("investigate.")) return "not an investigation action";
		const anchorNumber = await this.ctx.storage.get<number>(STORAGE.anchorNumber);
		if (anchorNumber === undefined) {
			return import.meta.env.DEV ? null : "no anchor number for investigation dispatch";
		}
		const creds = readAppCreds(this.env);
		const repo = readRepoContext(this.env);
		if (!creds || !repo) {
			console.log("[orchestrator] skipping investigation dispatch (creds or repo missing)", {
				anchorNumber,
			});
			return import.meta.env.DEV ? null : "GitHub credentials or repository context missing";
		}
		const mode = parseInvestigateMode(decision.action.slice("investigate.".length));
		if (!mode) return `unknown investigation mode "${decision.action}"`;
		const token = await this.getInstallationToken(creds);
		try {
			const [issue, previousBranchSha, mainBranchSha, lastDiagnosis] = await Promise.all([
				getIssue(token, repo, anchorNumber),
				getBranchSha(token, repo, `bot/fix-${anchorNumber}`),
				getBranchSha(token, repo, "main"),
				this.ctx.storage.get<StoredDiagnosis>(STORAGE.lastDiagnosis),
			]);
			const comments = await getIssueComments(token, repo, anchorNumber, {
				commentCount: issue.commentCount,
			});
			const trigger = input.triggeringComment ?? {
				id: null,
				body: arg ? `@emdashbot ${decision.event} ${arg}` : `@emdashbot ${decision.event}`,
				authorLogin: null,
				authorAssociation: null,
				actor: input.actor,
			};
			const context = buildIssueContext({
				diagnosis: lastDiagnosis ?? null,
				trigger,
				comments,
			}).text;
			const baseRef = investigationBaseRef(mode, mainBranchSha, previousBranchSha);
			const runId = crypto.randomUUID();
			const agentId = `investigate-${anchorNumber}-${runId}`;
			return {
				runId,
				agentId,
				issueNumber: anchorNumber,
				mode,
				arg,
				issueTitle: issue.title,
				issueBody: issue.body,
				previousBranchSha,
				context,
				baseRef,
			};
		} catch (err) {
			return `prepare investigation failed: ${errorMessage(err)}`;
		}
	}

	private async dispatchInvestigation(prepared: PreparedInvestigation): Promise<string | null> {
		const attemptId = crypto.randomUUID();
		await this.ctx.storage.transaction(async (transaction) => {
			await Promise.all([
				transaction.put(STORAGE.currentDispatchAttempt, attemptId),
				transaction.delete(STORAGE.currentDispatchError),
			]);
		});
		const dispatchPromise = Promise.resolve(
			dispatch(Investigate, {
				id: prepared.agentId,
				uid: null,
				message: {
					kind: "signal",
					type: "investigate.request",
					body: `Investigate issue #${prepared.issueNumber} in ${prepared.mode} mode.`,
				},
				initialData: {
					runId: prepared.runId,
					issueNumber: prepared.issueNumber,
					mode: prepared.mode,
					arg: prepared.arg,
					issueTitle: prepared.issueTitle,
					issueBody: prepared.issueBody,
					previousBranchSha: prepared.previousBranchSha,
					context: prepared.context,
					...(prepared.baseRef ? { baseRef: prepared.baseRef } : {}),
				},
			}),
		);
		const persistReceipt = async (receipt: Awaited<typeof dispatchPromise>) => {
			await this.ctx.storage.transaction(async (transaction) => {
				if ((await transaction.get<string>(STORAGE.currentRunId)) !== prepared.runId) return;
				if ((await transaction.get<string>(STORAGE.currentDispatchAttempt)) !== attemptId) return;
				await transaction.put(STORAGE.currentDispatchId, receipt.submissionId);
				await transaction.delete(STORAGE.currentDispatchAttempt);
				const pending = await transaction.get<PendingDispatch>(STORAGE.pendingDispatch);
				if (pending?.runId === prepared.runId) {
					if (pending.deliveryId) {
						const seen = (await transaction.get<string[]>(STORAGE.seenDeliveries)) ?? [];
						if (!seen.includes(pending.deliveryId)) {
							await transaction.put(
								STORAGE.seenDeliveries,
								[...seen, pending.deliveryId].slice(-DELIVERY_DEDUPE_LIMIT),
							);
						}
					}
					await transaction.delete(STORAGE.pendingDispatch);
				}
			});
		};
		this.ctx.waitUntil(
			dispatchPromise.then(
				(receipt) =>
					persistReceipt(receipt).catch((error) =>
						console.error("[orchestrator] failed to persist dispatch receipt", error),
					),
				(error) => {
					const message = error instanceof Error ? error.message : String(error);
					console.error("[orchestrator] investigation dispatch rejected", {
						runId: prepared.runId,
						error: message,
					});
					return this.recordDispatchFailure(prepared.runId, attemptId, message)
						.then(() => this.ctx.storage.setAlarm(Date.now()))
						.catch((persistError) =>
							console.error("[orchestrator] failed to persist dispatch rejection", persistError),
						);
				},
			),
		);
		let receipt: Awaited<typeof dispatchPromise>;
		try {
			receipt = await withDeadline(dispatchPromise, DISPATCH_TIMEOUT_MS, "Investigation dispatch");
		} catch (err) {
			if (err instanceof DeadlineExceededError) {
				// Admission may have completed even though the caller timed out. Keep
				// the run markers so a late callback or stale-run alarm can settle it.
				return `dispatch(investigate) uncertain: ${err.message}`;
			}
			throw err;
		}
		try {
			await persistReceipt(receipt);
		} catch (error) {
			return `dispatch(investigate) receipt persistence uncertain: ${error instanceof Error ? error.message : String(error)}`;
		}
		return null;
	}

	private async dispatchResumedRun(
		prepared: PreparedResume,
		dryRun: boolean,
	): Promise<string | null> {
		if (dryRun) {
			await this.ctx.storage.transaction(async (transaction) => {
				if ((await transaction.get<string>(STORAGE.currentRunId)) !== prepared.checkpoint.runId)
					return;
				await Promise.all([
					transaction.delete(STORAGE.pendingResume),
					transaction.delete(STORAGE.resumableRun),
				]);
			});
			return null;
		}

		const idempotencyKey = `resume:${prepared.checkpoint.runId}:${prepared.deliveryId ?? prepared.checkpoint.timedOutAt}`;
		const attemptId = crypto.randomUUID();
		await this.ctx.storage.transaction(async (transaction) => {
			await Promise.all([
				transaction.put(STORAGE.currentDispatchAttempt, attemptId),
				transaction.delete(STORAGE.currentDispatchError),
			]);
		});
		const dispatchPromise = Promise.resolve(
			dispatch(Investigate, {
				id: prepared.checkpoint.agentId,
				idempotencyKey,
				message: {
					kind: "signal",
					type: RESUME_SIGNAL_TYPE,
					tagName: "resume",
					attributes: { runId: prepared.checkpoint.runId },
					body: prepared.directive
						? `Resume the saved run. Additional maintainer directive: ${prepared.directive}`
						: "Resume the saved run from its timeout checkpoint and continue toward a verified report.",
				},
			}),
		);
		const persistReceipt = async (receipt: Awaited<typeof dispatchPromise>) => {
			await this.persistResumeReceipt(prepared, attemptId, receipt.submissionId);
		};
		this.ctx.waitUntil(
			dispatchPromise.then(
				(receipt) =>
					persistReceipt(receipt).catch((error) =>
						console.error("[orchestrator] failed to persist resume receipt", error),
					),
				(error) => {
					const message = errorMessage(error);
					console.error("[orchestrator] resume dispatch rejected", {
						runId: prepared.checkpoint.runId,
						error: message,
					});
					return this.recordDispatchFailure(prepared.checkpoint.runId, attemptId, message)
						.then(() => this.ctx.storage.setAlarm(Date.now()))
						.catch((persistError) =>
							console.error("[orchestrator] failed to persist resume rejection", persistError),
						);
				},
			),
		);

		let receipt: Awaited<typeof dispatchPromise>;
		try {
			receipt = await withDeadline(
				dispatchPromise,
				DISPATCH_TIMEOUT_MS,
				"Investigation resume admission",
			);
		} catch (error) {
			if (error instanceof DeadlineExceededError) {
				return `dispatch(resume) uncertain: ${error.message}`;
			}
			const message = errorMessage(error);
			await this.recordDispatchFailure(prepared.checkpoint.runId, attemptId, message);
			await this.ctx.storage.setAlarm(Date.now());
			return `dispatch(resume) rejected: ${message}`;
		}

		try {
			await persistReceipt(receipt);
		} catch (error) {
			return `dispatch(resume) receipt persistence uncertain: ${errorMessage(error)}`;
		}
		return null;
	}

	private async persistResumeReceipt(
		prepared: PreparedResume,
		attemptId: string,
		submissionId: string,
	): Promise<void> {
		await this.ctx.storage.transaction(async (transaction) => {
			if ((await transaction.get<string>(STORAGE.currentRunId)) !== prepared.checkpoint.runId)
				return;
			if ((await transaction.get<string>(STORAGE.currentDispatchAttempt)) !== attemptId) return;
			const seen = prepared.deliveryId
				? ((await transaction.get<string[]>(STORAGE.seenDeliveries)) ?? [])
				: null;
			await Promise.all([
				transaction.put(STORAGE.currentDispatchId, submissionId),
				transaction.delete(STORAGE.currentDispatchAttempt),
				transaction.delete(STORAGE.currentDispatchError),
				transaction.delete(STORAGE.pendingResume),
				transaction.delete(STORAGE.resumableRun),
				...(prepared.deliveryId && seen && !seen.includes(prepared.deliveryId)
					? [
							transaction.put(
								STORAGE.seenDeliveries,
								[...seen, prepared.deliveryId].slice(-DELIVERY_DEDUPE_LIMIT),
							),
						]
					: []),
			]);
		});
	}

	private async recordDispatchFailure(
		runId: string,
		attemptId: string,
		message: string,
	): Promise<void> {
		await this.ctx.storage.transaction(async (transaction) => {
			if ((await transaction.get<string>(STORAGE.currentRunId)) !== runId) return;
			if ((await transaction.get<string>(STORAGE.currentDispatchAttempt)) !== attemptId) return;
			await Promise.all([
				transaction.put(STORAGE.currentDispatchError, message),
				transaction.delete(STORAGE.currentDispatchAttempt),
			]);
		});
	}

	private async abortAgent(agentId: string): Promise<void> {
		const response = await this.ctx.exports.default.fetch(
			`https://self/agents/investigate/${encodeURIComponent(agentId)}/abort`,
			{
				method: "POST",
				headers: { authorization: `Bearer ${this.env.GITHUB_WEBHOOK_SECRET}` },
				signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
			},
		);
		if (!response.ok) {
			throw new Error(`agent abort failed: ${response.status} ${await response.text()}`);
		}
		const result = await response.json<{ aborted?: unknown }>();
		if (result.aborted === true) return;
		const status = await this.getAgentStatus(agentId);
		if (status === "settled" || status === "missing") return;
		throw new Error("agent abort did not settle an active submission");
	}

	private async getAgentStatus(agentId: string): Promise<"active" | "missing" | "settled"> {
		const response = await this.ctx.exports.default.fetch(
			`https://self/agents/investigate/${encodeURIComponent(agentId)}`,
			{
				headers: { authorization: `Bearer ${this.env.GITHUB_WEBHOOK_SECRET}` },
				signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
			},
		);
		if (response.status === 404) return "missing";
		if (!response.ok) {
			throw new Error(`agent status failed: ${response.status} ${await response.text()}`);
		}
		const snapshot = await response.json<{ settlements?: unknown }>();
		return Array.isArray(snapshot.settlements) && snapshot.settlements.length > 0
			? "settled"
			: "active";
	}

	/**
	 * Open (or reuse) the bot PR from the pushed fix branch `bot/fix-<n>`.
	 */
	private async runOpenPr(
		creds: Parameters<typeof mintInstallationToken>[0],
		repo: Parameters<typeof createPullRequest>[1],
		anchorNumber: number,
		draft = false,
	): Promise<string | null> {
		const token = await this.getInstallationToken(creds);
		const headBranch = `bot/fix-${anchorNumber}`;
		const kind = (await this.ctx.storage.get<Kind>(STORAGE.kind)) ?? "bug";
		const pullRequestCopy = draft
			? await this.ctx.storage.get<PullRequestCopy>(STORAGE.candidatePullRequest)
			: undefined;
		try {
			const created =
				(await getOpenPullRequest(token, repo, headBranch)) ??
				(await createPullRequest(token, repo, {
					headBranch,
					baseBranch: "main",
					title: pullRequestCopy?.title || renderPullRequestTitle(anchorNumber, kind),
					body: draft
						? renderDraftPrBody({
								issueNumber: anchorNumber,
								kind,
								description:
									pullRequestCopy?.description ||
									`Automated candidate change for issue #${anchorNumber}.`,
								previewPackage: this.env.PREVIEW_PACKAGE,
							})
						: `Fixes #${anchorNumber}.\n\nAutomated PR opened by emdashbot.`,
					draft,
				}));
			await this.ctx.storage.put(STORAGE.prNumber, created.number);
			return null;
		} catch (err) {
			return `openPr failed: ${errorMessage(err)}`;
		}
	}

	/**
	 * Reap the fix loop's bot branches. The artifacts branch is always deleted;
	 * the fix branch is spared when an open PR references it (deleting the ref
	 * would silently close that PR). Shared by the reject/expire/decline reap
	 * edges and the issue-close cleanup path.
	 */
	private async runReapBranch(
		creds: Parameters<typeof mintInstallationToken>[0],
		repo: Parameters<typeof deleteBranch>[1],
		anchorNumber: number,
	): Promise<string | null> {
		try {
			const token = await this.getInstallationToken(creds);
			const openPr = await getOpenPullRequest(token, repo, `bot/fix-${anchorNumber}`);
			for (const branch of branchesToReap(anchorNumber, openPr !== null)) {
				await deleteBranch(token, repo, branch);
			}
			return null;
		} catch (err) {
			return `reapBranch failed: ${errorMessage(err)}`;
		}
	}

	private async runClosePr(
		creds: Parameters<typeof mintInstallationToken>[0],
		repo: Parameters<typeof closePullRequest>[1],
	): Promise<string | null> {
		const prNumber = await this.ctx.storage.get<number>(STORAGE.prNumber);
		if (prNumber === undefined) {
			return "closePr: no PR number persisted";
		}
		try {
			const token = await this.getInstallationToken(creds);
			await closePullRequest(token, repo, prNumber);
			return null;
		} catch (err) {
			return `closePr failed: ${errorMessage(err)}`;
		}
	}

	// ---------------- Readonly replies (status / help) ----------------

	private async postReadonlyReply(
		decision: Extract<Decision, { kind: "readonly" }>,
		input: NormalizedEvent,
	): Promise<void> {
		const anchorNumber = await this.ctx.storage.get<number>(STORAGE.anchorNumber);
		if (anchorNumber === undefined) {
			if (import.meta.env.DEV) return;
			throw new Error("no anchor number for readonly reply");
		}

		const persistedState = await this.ctx.storage.get<StateId>(STORAGE.state);
		const state = decision.state ?? persistedState ?? null;
		const replyEvent = decision.event === "help" ? "help" : "status";
		const id = await this.persistStandaloneSideEffect({
			anchorNumber,
			commentBody: renderReadonlyReply(
				state,
				replyEvent,
				input.actor === "reporter" ? "reporter" : "maintainer",
			),
			...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
		});
		await this.armAlarm();
		await this.drainPendingSideEffects();
		if (await this.hasPendingSideEffect(id)) {
			throw new Error("readonly reply is queued behind an earlier GitHub projection");
		}
	}

	private async postCommandFeedback(
		input: NormalizedEvent,
		resolvedState?: StateId | null,
	): Promise<void> {
		if (input.dryRun === true || (input.actor !== "maintainer" && input.actor !== "reporter")) {
			return;
		}
		const anchorNumber =
			input.anchorNumber ?? (await this.ctx.storage.get<number>(STORAGE.anchorNumber));
		if (anchorNumber === undefined) {
			if (import.meta.env.DEV) return;
			throw new Error("no anchor number for command feedback");
		}
		const persistedState = await this.ctx.storage.get<StateId>(STORAGE.state);
		const state = resolvedState ?? persistedState ?? currentState(input.labels);
		const id = await this.persistStandaloneSideEffect({
			anchorNumber,
			commentBody: renderCommandFeedback(state, input.event, input.actor),
			...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
		});
		await this.armAlarm();
		await this.drainPendingSideEffects();
		if (await this.hasPendingSideEffect(id)) {
			throw new Error("command feedback is queued behind an earlier GitHub projection");
		}
	}

	private async postResumeUnavailable(input: NormalizedEvent): Promise<void> {
		const anchorNumber =
			input.anchorNumber ?? (await this.ctx.storage.get<number>(STORAGE.anchorNumber));
		if (anchorNumber === undefined) {
			if (import.meta.env.DEV) return;
			throw new Error("no anchor number for resume reply");
		}
		const id = await this.persistStandaloneSideEffect({
			anchorNumber,
			commentBody:
				"There isn't a saved timed-out run to resume. Start a fresh run with `@emdashbot retry`, `@emdashbot investigate`, or `@emdashbot implement <directive>`.",
			...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
		});
		await this.armAlarm();
		await this.drainPendingSideEffects();
		if (await this.hasPendingSideEffect(id)) {
			throw new Error("resume reply is queued behind an earlier GitHub projection");
		}
	}

	// ---------------- Side effects (GitHub) ----------------

	private async drainPendingWorkComments(): Promise<void> {
		for (;;) {
			const comments =
				(await this.ctx.storage.get<WorkCommentProjection[]>(STORAGE.workComments)) ?? [];
			const pending = comments.find((comment) => comment.pending);
			if (!pending) return;
			await this.flushWorkComment(pending.runId);
		}
	}

	private async flushWorkComment(runId: string): Promise<void> {
		const comments =
			(await this.ctx.storage.get<WorkCommentProjection[]>(STORAGE.workComments)) ?? [];
		let projection = comments.find((comment) => comment.runId === runId);
		if (!projection?.pending) return;
		const creds = readAppCreds(this.env);
		const repo = readRepoContext(this.env);
		if (!creds || !repo) {
			if (import.meta.env.DEV) {
				await this.updateWorkComment(runId, (comment) => ({ ...comment, pending: false }));
				return;
			}
			throw new Error("GitHub credentials or repository context missing");
		}
		const token = await this.getInstallationToken(creds);
		const body = `${projection.body}\n\n${projection.marker}`;
		let commentId = projection.commentId;
		if (commentId !== null && !(await updateIssueComment(token, repo, commentId, body))) {
			commentId = null;
		}
		if (commentId === null && projection.commentMayExist) {
			const found = await findIssueCommentByMarker(
				token,
				repo,
				projection.anchorNumber,
				projection.marker,
			);
			commentId = found?.id ?? null;
			if (commentId !== null && !(await updateIssueComment(token, repo, commentId, body))) {
				commentId = null;
			}
		}
		if (commentId === null) {
			await this.updateWorkComment(runId, (comment) => ({
				...comment,
				commentMayExist: true,
			}));
			projection =
				((await this.ctx.storage.get<WorkCommentProjection[]>(STORAGE.workComments)) ?? []).find(
					(comment) => comment.runId === runId,
				) ?? projection;
			const created = await createIssueComment(
				token,
				repo,
				projection.anchorNumber,
				`${projection.body}\n\n${projection.marker}`,
			);
			commentId = created.id;
		}
		await this.updateWorkComment(runId, (comment) => ({
			...comment,
			commentId,
			commentMayExist: true,
			pending: false,
		}));
	}

	private async updateWorkComment(
		runId: string,
		update: (comment: WorkCommentProjection) => WorkCommentProjection,
	): Promise<void> {
		await this.ctx.storage.transaction(async (transaction) => {
			const comments = (await transaction.get<WorkCommentProjection[]>(STORAGE.workComments)) ?? [];
			if (!comments.some((comment) => comment.runId === runId)) return;
			await transaction.put(
				STORAGE.workComments,
				comments.map((comment) => (comment.runId === runId ? update(comment) : comment)),
			);
		});
	}

	private async flushPendingSideEffect(id: string): Promise<void> {
		const pending = (
			(await this.ctx.storage.get<PendingSideEffect[]>(STORAGE.pendingSideEffects)) ?? []
		).find((effect) => effect.id === id);
		if (!pending) return;
		const creds = readAppCreds(this.env);
		const repo = readRepoContext(this.env);
		if (!creds || !repo) {
			if (import.meta.env.DEV) {
				await this.completePendingSideEffect(pending);
				return;
			}
			throw new Error("GitHub credentials or repository context missing");
		}

		const token = await this.getInstallationToken(creds);
		let current: PendingSideEffect = pending;
		const applyLabels = () => this.applySideEffectLabels(token, repo, current);
		const postComment = async () => {
			current = await this.postSideEffectComment(token, repo, current);
		};
		// The fix-loop ask posts first: if it fails, the labels stay put so the
		// item never advertises awaiting-reporter without an ask on the thread.
		if (current.commentFirst) {
			await postComment();
			await applyLabels();
		} else {
			await applyLabels();
			await postComment();
		}

		await this.completePendingSideEffect(current);
	}

	private async applySideEffectLabels(
		token: string,
		repo: RepoContext,
		pending: PendingSideEffect,
	): Promise<void> {
		await addLabels(token, repo, pending.anchorNumber, pending.addLabels);
		await removeLabels(token, repo, pending.anchorNumber, pending.removeLabels);
	}

	/** Post the effect's comment at-most-once, returning the effect with the
	 * marker-may-exist flag persisted so a retry doesn't double-post. */
	private async postSideEffectComment(
		token: string,
		repo: RepoContext,
		pending: PendingSideEffect,
	): Promise<PendingSideEffect> {
		if (!pending.commentBody) return pending;
		let exists = false;
		let updated = pending;
		if (pending.commentMayExist) {
			exists = await hasIssueCommentMarker(
				token,
				repo,
				pending.anchorNumber,
				pending.commentMarker,
			);
		} else {
			await this.markCommentMayExist(pending.id);
			updated = { ...pending, commentMayExist: true };
		}
		if (!exists) {
			await postIssueComment(
				token,
				repo,
				pending.anchorNumber,
				`${pending.commentBody}\n\n${pending.commentMarker}`,
			);
		}
		return updated;
	}

	private async getInstallationToken(creds: Parameters<typeof mintInstallationToken>[0]) {
		const cached = await this.ctx.storage.get<CachedToken>(STORAGE.tokenCache);
		if (cached && cached.expiresAt > Date.now()) return cached.token;
		const token = await mintInstallationToken(creds);
		await this.ctx.storage.put<CachedToken>(STORAGE.tokenCache, {
			token,
			expiresAt: Date.now() + 55 * 60 * 1000,
		});
		return token;
	}

	// ---------------- Private helpers ----------------

	private async persistDecision(
		decision: Extract<Decision, { kind: "transition" }>,
		input: NormalizedEvent,
		preparedInvestigation: PreparedInvestigation | null = null,
		preparedResume: PreparedResume | null = null,
	): Promise<string | null> {
		const sideEffectId = input.dryRun ? null : crypto.randomUUID();
		return this.ctx.storage.transaction(async (transaction) => {
			const now = Date.now();
			const existing = (await transaction.get<EventLogEntry[]>(STORAGE.eventLog)) ?? [];
			const entry: EventLogEntry = {
				t: now,
				event: decision.event,
				actor: input.actor,
				from: decision.from === "conflicting" ? "conflicting" : decision.from,
				to: decision.to,
				...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
			};
			const eventLog = [...existing, entry].slice(-EVENT_LOG_LIMIT);
			const puts: Promise<unknown>[] = [
				transaction.put(STORAGE.state, decision.to),
				transaction.put(STORAGE.eventLog, eventLog),
				decision.to === "awaiting_reporter"
					? transaction.put(STORAGE.awaitingReporterSince, now)
					: transaction.delete(STORAGE.awaitingReporterSince),
			];
			if (input.settlesDeliveryId) {
				const seen = (await transaction.get<string[]>(STORAGE.seenDeliveries)) ?? [];
				if (!seen.includes(input.settlesDeliveryId)) {
					puts.push(
						transaction.put(
							STORAGE.seenDeliveries,
							[...seen, input.settlesDeliveryId].slice(-DELIVERY_DEDUPE_LIMIT),
						),
					);
				}
			}
			if (decision.event.startsWith("agent.") && input.settlesRunId) {
				const run = await transaction.get<RunLifecycle>(STORAGE.runLifecycle);
				if (run?.runId === input.settlesRunId) {
					const status =
						decision.event === "agent.failed"
							? input.agentFailureStage === "timeout"
								? "timed_out"
								: "failed"
							: "succeeded";
					puts.push(transaction.put(STORAGE.runLifecycle, settleRunLifecycle(run, status, now)));
				}
			}
			if (decision.event === "agent.failed" && input.settlesRunId) {
				const run = await transaction.get<RunLifecycle>(STORAGE.runLifecycle);
				const failedRunMode =
					run?.runId === input.settlesRunId
						? run.mode
						: await transaction.get<InvestigationMode>(STORAGE.currentRunMode);
				if (failedRunMode) puts.push(transaction.put(STORAGE.failedRunMode, failedRunMode));
			}
			if (decision.to === "preview_building") {
				const startedAt = now;
				puts.push(
					transaction.put(STORAGE.previewBuildDeadline, startedAt + PREVIEW_BUILD_TIMEOUT_MS),
					transaction.put(STORAGE.previewPollNextAt, startedAt + PREVIEW_POLL_INITIAL_MS),
					transaction.put(STORAGE.previewNotes, input.agentSummary ?? ""),
					input.agentScreenshots?.length
						? transaction.put(STORAGE.previewScreenshots, input.agentScreenshots)
						: transaction.delete(STORAGE.previewScreenshots),
					transaction.put<PullRequestCopy>(
						STORAGE.candidatePullRequest,
						input.agentPullRequest ?? {
							title: "",
							description: input.agentSummary ?? "",
						},
					),
				);
			} else {
				puts.push(
					transaction.delete(STORAGE.previewBuildDeadline),
					transaction.delete(STORAGE.previewPollNextAt),
					transaction.delete(STORAGE.previewNotes),
					transaction.delete(STORAGE.previewScreenshots),
					...(decision.to === "awaiting_reporter"
						? []
						: [transaction.delete(STORAGE.candidatePullRequest)]),
				);
			}
			const kindLabel = decision.addLabels.find(
				(label) => label.startsWith("bot:") && label !== decision.addLabel,
			);
			if (kindLabel) {
				const kind = parseKind(kindLabel.slice("bot:".length));
				if (kind) puts.push(transaction.put(STORAGE.kind, kind));
			}
			if (preparedInvestigation) {
				const run = startRunLifecycle({
					runId: preparedInvestigation.runId,
					mode: preparedInvestigation.mode,
					startedAt: now,
				});
				puts.push(
					transaction.put(STORAGE.currentRunId, preparedInvestigation.runId),
					transaction.put(STORAGE.currentRunMode, preparedInvestigation.mode),
					transaction.put(STORAGE.currentRunStartedAt, now),
					transaction.put(STORAGE.runLifecycle, run),
					transaction.put(STORAGE.currentRunDryRun, input.dryRun === true),
					transaction.delete(STORAGE.workPlan),
					transaction.put(STORAGE.currentAgentId, preparedInvestigation.agentId),
					transaction.delete(STORAGE.deadlineWarningSentRunId),
					transaction.delete(STORAGE.deadlineWarningRetryAt),
					transaction.delete(STORAGE.failedRunMode),
					transaction.put(STORAGE.pendingDispatch, {
						...preparedInvestigation,
						...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
					} satisfies PendingDispatch),
					transaction.delete(STORAGE.resumableRun),
				);
			}
			if (preparedResume) {
				const existingRun = await transaction.get<RunLifecycle>(STORAGE.runLifecycle);
				const run =
					existingRun?.runId === preparedResume.checkpoint.runId
						? resumeRunLifecycle(existingRun, now)
						: startRunLifecycle({
								runId: preparedResume.checkpoint.runId,
								mode: preparedResume.checkpoint.mode,
								startedAt: now,
							});
				puts.push(
					transaction.put(STORAGE.currentRunId, preparedResume.checkpoint.runId),
					transaction.put(STORAGE.currentRunMode, preparedResume.checkpoint.mode),
					transaction.put(STORAGE.currentRunStartedAt, now),
					transaction.put(STORAGE.runLifecycle, run),
					transaction.put(STORAGE.currentRunDryRun, input.dryRun === true),
					transaction.put(STORAGE.currentAgentId, preparedResume.checkpoint.agentId),
					transaction.delete(STORAGE.deadlineWarningSentRunId),
					transaction.delete(STORAGE.deadlineWarningRetryAt),
					transaction.delete(STORAGE.failedRunMode),
					transaction.put(STORAGE.pendingResume, {
						...preparedResume,
						dryRun: input.dryRun === true,
					} satisfies PendingResume),
				);
			}
			if (
				!preparedResume &&
				(decision.event === "reset" ||
					decision.event === "decline" ||
					decision.event === "take_over")
			) {
				const run = await transaction.get<RunLifecycle>(STORAGE.runLifecycle);
				puts.push(
					transaction.delete(STORAGE.resumableRun),
					transaction.delete(STORAGE.failedRunMode),
					...(run?.status === "running"
						? [transaction.put(STORAGE.runLifecycle, settleRunLifecycle(run, "cancelled", now))]
						: []),
				);
			}
			const anchorNumber =
				input.anchorNumber ?? (await transaction.get<number>(STORAGE.anchorNumber));
			const effectRunId =
				preparedInvestigation?.runId ?? preparedResume?.checkpoint.runId ?? input.settlesRunId;
			const effectDeliveryId = input.settlesDeliveryId ?? input.deliveryId;
			if (sideEffectId && anchorNumber !== undefined) {
				const pending =
					(await transaction.get<PendingSideEffect[]>(STORAGE.pendingSideEffects)) ?? [];
				puts.push(
					transaction.put(STORAGE.pendingSideEffects, [
						...pending,
						{
							id: sideEffectId,
							...(effectDeliveryId ? { deliveryId: effectDeliveryId } : {}),
							...(effectRunId ? { runId: effectRunId } : {}),
							settlesRun: input.settlesRunId !== undefined,
							anchorNumber,
							addLabels: decision.addLabels,
							removeLabels: decision.removeLabels,
							commentBody:
								input.commentBodyOverride ??
								renderComment(
									decision,
									anchorNumber,
									input.agentSummary,
									{
										runId: input.agentRunId,
										failureStage: input.agentFailureStage,
									},
									this.env.PREVIEW_PACKAGE,
								),
							commentMarker: `<!-- emdashbot-event:${sideEffectId} -->`,
							commentMayExist: false,
							...(input.commentFirst ? { commentFirst: true } : {}),
						} satisfies PendingSideEffect,
					]),
				);
			}
			await Promise.all(puts);
			return sideEffectId && anchorNumber !== undefined ? sideEffectId : null;
		});
	}

	/**
	 * Read the current GitHub labels for this issue. Stubbed in the skeleton;
	 * the real implementation calls the GitHub API via the bound App token in
	 * the next commit. Used by `applyAgentResult` so the synthesized follow-up
	 * `event()` call has a label snapshot for the router.
	 *
	 * For now, derive a synthetic label set from persisted DO state so the
	 * skeleton path is self-consistent in tests.
	 */
	private async projectLabels(): Promise<readonly string[]> {
		const [state, kind] = await Promise.all([
			this.ctx.storage.get<StateId>(STORAGE.state),
			this.ctx.storage.get<Kind>(STORAGE.kind),
		]);
		const out: string[] = [];
		if (state) {
			const label = STATES[state].label;
			if (label) out.push(label);
		}
		if (kind) out.push(`bot:${kind}`);
		return out;
	}

	private async isDeliverySeen(deliveryId: string): Promise<boolean> {
		const seen = (await this.ctx.storage.get<string[]>(STORAGE.seenDeliveries)) ?? [];
		return seen.includes(deliveryId);
	}

	private async recordDelivery(deliveryId: string): Promise<void> {
		const seen = (await this.ctx.storage.get<string[]>(STORAGE.seenDeliveries)) ?? [];
		if (seen.includes(deliveryId)) return;
		seen.push(deliveryId);
		const trimmed = seen.length > DELIVERY_DEDUPE_LIMIT ? seen.slice(-DELIVERY_DEDUPE_LIMIT) : seen;
		await this.ctx.storage.put(STORAGE.seenDeliveries, trimmed);
	}

	private async clearRun(expectedRunId: string | undefined): Promise<void> {
		if (!expectedRunId) return;
		await this.ctx.storage.transaction(async (transaction) => {
			const currentRunId = await transaction.get<string>(STORAGE.currentRunId);
			if (currentRunId !== expectedRunId) return;
			await Promise.all([
				transaction.delete(STORAGE.currentRunId),
				transaction.delete(STORAGE.currentRunMode),
				transaction.delete(STORAGE.currentRunStartedAt),
				transaction.delete(STORAGE.currentRunDryRun),
				transaction.delete(STORAGE.currentAgentId),
				transaction.delete(STORAGE.currentDispatchId),
				transaction.delete(STORAGE.currentDispatchError),
				transaction.delete(STORAGE.currentDispatchAttempt),
				transaction.delete(STORAGE.abortConfirmedRunId),
				transaction.delete(STORAGE.deadlineWarningSentRunId),
				transaction.delete(STORAGE.deadlineWarningRetryAt),
			]);
			const pending = await transaction.get<PendingDispatch>(STORAGE.pendingDispatch);
			if (pending?.runId === expectedRunId) await transaction.delete(STORAGE.pendingDispatch);
			const pendingResume = await transaction.get<PendingResume>(STORAGE.pendingResume);
			if (pendingResume?.checkpoint.runId === expectedRunId) {
				await transaction.delete(STORAGE.pendingResume);
			}
		});
	}

	private async resumePendingDispatch(deliveryId: string): Promise<boolean> {
		const [pendingDispatch, dispatchAttempt, dispatchError] = await Promise.all([
			this.ctx.storage.get<PendingDispatch>(STORAGE.pendingDispatch),
			this.ctx.storage.get<string>(STORAGE.currentDispatchAttempt),
			this.ctx.storage.get<string>(STORAGE.currentDispatchError),
		]);
		if (pendingDispatch?.deliveryId !== deliveryId) return false;
		if (dispatchError) throw new Error(`dispatch(investigate) rejected: ${dispatchError}`);
		if (dispatchAttempt) throw new Error("dispatch(investigate) admission is still uncertain");
		const runError = await this.dispatchInvestigation(pendingDispatch);
		if (runError) throw new Error(runError);
		return true;
	}

	private async resumePendingRun(deliveryId: string): Promise<boolean> {
		const [pending, dispatchAttempt, dispatchError] = await Promise.all([
			this.ctx.storage.get<PendingResume>(STORAGE.pendingResume),
			this.ctx.storage.get<string>(STORAGE.currentDispatchAttempt),
			this.ctx.storage.get<string>(STORAGE.currentDispatchError),
		]);
		if (pending?.deliveryId !== deliveryId) return false;
		if (dispatchError) throw new Error(`dispatch(resume) rejected: ${dispatchError}`);
		if (dispatchAttempt) throw new Error("dispatch(resume) admission is still uncertain");
		const runError = await this.dispatchResumedRun(pending, pending.dryRun);
		if (runError) throw new Error(runError);
		return true;
	}

	private async drainPendingSideEffects(): Promise<Set<string>> {
		const settledRuns = new Set<string>();
		for (;;) {
			const [effects, pendingDispatch, pendingResume] = await Promise.all([
				this.ctx.storage.get<PendingSideEffect[]>(STORAGE.pendingSideEffects),
				this.ctx.storage.get<PendingDispatch>(STORAGE.pendingDispatch),
				this.ctx.storage.get<PendingResume>(STORAGE.pendingResume),
			]);
			const effect = effects?.[0];
			if (!effect) return settledRuns;
			// Defer only a launch effect belonging to the still-pending dispatch.
			// A standalone effect (runId undefined) must not be held back -- and
			// `undefined === pendingDispatch?.runId` when no dispatch is pending
			// would otherwise wedge it here forever.
			if (
				!effect.settlesRun &&
				effect.runId !== undefined &&
				(effect.runId === pendingDispatch?.runId ||
					effect.runId === pendingResume?.checkpoint.runId)
			)
				return settledRuns;

			await this.flushPendingSideEffect(effect.id);
			if (effect.settlesRun && effect.runId) settledRuns.add(effect.runId);
		}
	}

	private async confirmDispatchAdmission(runId: string): Promise<void> {
		await this.ctx.storage.transaction(async (transaction) => {
			const [pendingDispatch, pendingResume] = await Promise.all([
				transaction.get<PendingDispatch>(STORAGE.pendingDispatch),
				transaction.get<PendingResume>(STORAGE.pendingResume),
			]);
			const matchesDispatch = pendingDispatch?.runId === runId;
			const matchesResume = pendingResume?.checkpoint.runId === runId;
			if (!matchesDispatch && !matchesResume) return;
			const deliveryId = matchesDispatch ? pendingDispatch.deliveryId : pendingResume.deliveryId;
			if (deliveryId) {
				const seen = (await transaction.get<string[]>(STORAGE.seenDeliveries)) ?? [];
				if (!seen.includes(deliveryId)) {
					await transaction.put(
						STORAGE.seenDeliveries,
						[...seen, deliveryId].slice(-DELIVERY_DEDUPE_LIMIT),
					);
				}
			}
			await Promise.all([
				...(matchesDispatch ? [transaction.delete(STORAGE.pendingDispatch)] : []),
				...(matchesResume ? [transaction.delete(STORAGE.pendingResume)] : []),
				transaction.delete(STORAGE.currentDispatchAttempt),
				transaction.delete(STORAGE.currentDispatchError),
			]);
		});
	}

	private async hasPendingSideEffects(): Promise<boolean> {
		return (
			((await this.ctx.storage.get<PendingSideEffect[]>(STORAGE.pendingSideEffects)) ?? []).length >
			0
		);
	}

	private async hasPendingSideEffect(id: string): Promise<boolean> {
		return (
			(await this.ctx.storage.get<PendingSideEffect[]>(STORAGE.pendingSideEffects)) ?? []
		).some((effect) => effect.id === id);
	}

	private async discardLaunchSideEffects(runId: string): Promise<void> {
		await this.ctx.storage.transaction(async (transaction) => {
			const effects =
				(await transaction.get<PendingSideEffect[]>(STORAGE.pendingSideEffects)) ?? [];
			const remaining = effects.filter((effect) => effect.runId !== runId || effect.settlesRun);
			if (remaining.length === 0) await transaction.delete(STORAGE.pendingSideEffects);
			else await transaction.put(STORAGE.pendingSideEffects, remaining);
		});
	}

	private async persistStandaloneSideEffect(input: {
		anchorNumber: number;
		commentBody: string;
		deliveryId?: string;
	}): Promise<string> {
		const id = crypto.randomUUID();
		await this.ctx.storage.transaction(async (transaction) => {
			const effects =
				(await transaction.get<PendingSideEffect[]>(STORAGE.pendingSideEffects)) ?? [];
			await transaction.put(STORAGE.pendingSideEffects, [
				...effects,
				{
					id,
					...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
					anchorNumber: input.anchorNumber,
					addLabels: [],
					removeLabels: [],
					commentBody: input.commentBody,
					commentMarker: `<!-- emdashbot-event:${id} -->`,
					commentMayExist: false,
					settlesRun: false,
				} satisfies PendingSideEffect,
			]);
		});
		return id;
	}

	private async markCommentMayExist(id: string): Promise<void> {
		await this.ctx.storage.transaction(async (transaction) => {
			const effects =
				(await transaction.get<PendingSideEffect[]>(STORAGE.pendingSideEffects)) ?? [];
			await transaction.put(
				STORAGE.pendingSideEffects,
				effects.map((effect) => (effect.id === id ? { ...effect, commentMayExist: true } : effect)),
			);
		});
	}

	private async completePendingSideEffect(effect: PendingSideEffect): Promise<void> {
		await this.ctx.storage.transaction(async (transaction) => {
			const effects =
				(await transaction.get<PendingSideEffect[]>(STORAGE.pendingSideEffects)) ?? [];
			if (!effects.some((candidate) => candidate.id === effect.id)) return;
			const remaining = effects.filter((candidate) => candidate.id !== effect.id);
			if (remaining.length === 0) await transaction.delete(STORAGE.pendingSideEffects);
			else await transaction.put(STORAGE.pendingSideEffects, remaining);

			if (effect.deliveryId) {
				const seen = (await transaction.get<string[]>(STORAGE.seenDeliveries)) ?? [];
				if (!seen.includes(effect.deliveryId)) {
					await transaction.put(
						STORAGE.seenDeliveries,
						[...seen, effect.deliveryId].slice(-DELIVERY_DEDUPE_LIMIT),
					);
				}
			}

			if (
				effect.settlesRun &&
				effect.runId &&
				(await transaction.get<string>(STORAGE.currentRunId)) === effect.runId
			) {
				await Promise.all([
					transaction.delete(STORAGE.currentRunId),
					transaction.delete(STORAGE.currentRunMode),
					transaction.delete(STORAGE.currentRunStartedAt),
					transaction.delete(STORAGE.currentRunDryRun),
					transaction.delete(STORAGE.currentAgentId),
					transaction.delete(STORAGE.currentDispatchId),
					transaction.delete(STORAGE.currentDispatchError),
					transaction.delete(STORAGE.currentDispatchAttempt),
					transaction.delete(STORAGE.pendingDispatch),
					transaction.delete(STORAGE.pendingResume),
					transaction.delete(STORAGE.abortConfirmedRunId),
					transaction.delete(STORAGE.deadlineWarningSentRunId),
					transaction.delete(STORAGE.deadlineWarningRetryAt),
				]);
			}
		});
	}

	private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationTail.then(operation, operation);
		this.operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	// ---------------- Read-only inspection (test + debug) ----------------

	async getPersistedState(): Promise<PersistedState> {
		const [state, kind, currentRunId, currentAgentId, currentDispatchId, prNumber] =
			await Promise.all([
				this.ctx.storage.get<StateId>(STORAGE.state),
				this.ctx.storage.get<Kind>(STORAGE.kind),
				this.ctx.storage.get<string>(STORAGE.currentRunId),
				this.ctx.storage.get<string>(STORAGE.currentAgentId),
				this.ctx.storage.get<string>(STORAGE.currentDispatchId),
				this.ctx.storage.get<number>(STORAGE.prNumber),
			]);
		return {
			state: state ?? null,
			kind: kind ?? null,
			currentRunId: currentRunId ?? null,
			currentAgentId: currentAgentId ?? null,
			currentDispatchId: currentDispatchId ?? null,
			prNumber: prNumber ?? null,
		};
	}

	async getEventLog(): Promise<readonly EventLogEntry[]> {
		return (await this.ctx.storage.get<EventLogEntry[]>(STORAGE.eventLog)) ?? [];
	}

	async getPublicSnapshot(): Promise<PublicIssueSnapshot> {
		const [
			state,
			kind,
			run,
			storedWorkPlan,
			legacyMode,
			currentRunStartedAt,
			prNumber,
			transitions,
			progress,
		] = await Promise.all([
			this.ctx.storage.get<StateId>(STORAGE.state),
			this.ctx.storage.get<Kind>(STORAGE.kind),
			this.ctx.storage.get<RunLifecycle>(STORAGE.runLifecycle),
			this.ctx.storage.get<StoredWorkPlan>(STORAGE.workPlan),
			this.ctx.storage.get<InvestigationMode>(STORAGE.currentRunMode),
			this.ctx.storage.get<number>(STORAGE.currentRunStartedAt),
			this.ctx.storage.get<number>(STORAGE.prNumber),
			this.ctx.storage.get<EventLogEntry[]>(STORAGE.eventLog),
			this.ctx.storage.get<PublicProgressEntry[]>(STORAGE.publicProgress),
		]);
		const publicRun = run
			? publicRunLifecycle(run)
			: legacyMode && currentRunStartedAt !== undefined
				? publicRunLifecycle(
						startRunLifecycle({
							runId: "legacy",
							mode: legacyMode,
							startedAt: currentRunStartedAt,
						}),
					)
				: null;
		return {
			state: state ?? null,
			kind: kind ?? null,
			run: publicRun,
			workPlan: storedWorkPlan?.plan ?? null,
			currentRunStartedAt: currentRunStartedAt ?? null,
			prNumber: prNumber ?? null,
			transitions: (transitions ?? []).map(({ t, event, from, to }) => ({
				t,
				event,
				from,
				to,
			})),
			progress: (progress ?? []).map(({ t, kind: progressKind, title, detail }) => ({
				t,
				kind: progressKind,
				title,
				detail,
			})),
		};
	}

	async getInboxDepth(): Promise<number> {
		return ((await this.ctx.storage.get<InboxEntry[]>(STORAGE.inbox)) ?? []).length;
	}

	/** Test-only: pending GitHub projection queue depth. */
	async getPendingSideEffectCount(): Promise<number> {
		return ((await this.ctx.storage.get<PendingSideEffect[]>(STORAGE.pendingSideEffects)) ?? [])
			.length;
	}

	/** Test-only: inject a synthetic in-flight run for tick() recovery tests. */
	async debugSetStaleRun(
		runId: string,
		startedAt: number,
		agentId?: string,
		mode?: InvestigationMode,
	): Promise<void> {
		await Promise.all([
			this.ctx.storage.put(STORAGE.currentRunId, runId),
			this.ctx.storage.put(STORAGE.currentRunStartedAt, startedAt),
			this.ctx.storage.delete(STORAGE.deadlineWarningSentRunId),
			this.ctx.storage.delete(STORAGE.deadlineWarningRetryAt),
			...(agentId ? [this.ctx.storage.put(STORAGE.currentAgentId, agentId)] : []),
			...(mode ? [this.ctx.storage.put(STORAGE.currentRunMode, mode)] : []),
			...(mode
				? [
						this.ctx.storage.put(
							STORAGE.runLifecycle,
							startRunLifecycle({ runId, mode, startedAt }),
						),
					]
				: []),
		]);
	}

	/** Test-only: inspect the diagnosis retained for a later write run. */
	async debugGetLastDiagnosis(): Promise<StoredDiagnosis | null> {
		return (await this.ctx.storage.get<StoredDiagnosis>(STORAGE.lastDiagnosis)) ?? null;
	}

	/** Test-only: inspect the resumable checkpoint retained after a timeout. */
	async debugGetResumableRun(): Promise<ResumableRunCheckpoint | null> {
		return (await this.ctx.storage.get<ResumableRunCheckpoint>(STORAGE.resumableRun)) ?? null;
	}

	/** Test-only: seed a resumable checkpoint without invoking the model. */
	async debugSetResumableRun(checkpoint: ResumableRunCheckpoint): Promise<void> {
		await this.ctx.storage.put(STORAGE.resumableRun, checkpoint);
	}

	/** Test-only: inspect the current run's fixed deadline and warning marker. */
	async debugGetRunSchedule(): Promise<{
		deadlineAt: number | null;
		warningAt: number | null;
		warningSentRunId: string | null;
	}> {
		const [runId, run, legacyMode, legacyStartedAt, warningSentRunId] = await Promise.all([
			this.ctx.storage.get<string>(STORAGE.currentRunId),
			this.ctx.storage.get<RunLifecycle>(STORAGE.runLifecycle),
			this.ctx.storage.get<InvestigationMode>(STORAGE.currentRunMode),
			this.ctx.storage.get<number>(STORAGE.currentRunStartedAt),
			this.ctx.storage.get<string>(STORAGE.deadlineWarningSentRunId),
		]);
		const activeRun = run && run.runId === runId && run.status === "running" ? run : null;
		const mode = activeRun?.mode ?? legacyMode;
		const startedAt = activeRun?.startedAt ?? legacyStartedAt;
		if (!runId || !mode || startedAt === undefined) {
			return { deadlineAt: null, warningAt: null, warningSentRunId: warningSentRunId ?? null };
		}
		const schedule = runSchedule(mode, startedAt, warningSentRunId === runId);
		return { ...schedule, warningSentRunId: warningSentRunId ?? null };
	}

	/** Test-only: backdate the reporter-confirmation window to force expiry. */
	async debugBackdateReporterWait(since: number): Promise<void> {
		await this.ctx.storage.put(STORAGE.awaitingReporterSince, since);
	}

	/** Test-only: force the preview-poll schedule so a tick probes immediately. */
	async debugSetPreviewPoll(deadline: number, nextAt: number): Promise<void> {
		await Promise.all([
			this.ctx.storage.put(STORAGE.previewBuildDeadline, deadline),
			this.ctx.storage.put(STORAGE.previewPollNextAt, nextAt),
		]);
	}

	/** Test-only: seed the installation-token cache so side effects skip the JWT
	 * mint (which needs a real private key) and go straight to the fake GitHub. */
	async debugSetTokenCache(token: string, expiresAt: number): Promise<void> {
		await this.ctx.storage.put<CachedToken>(STORAGE.tokenCache, { token, expiresAt });
	}

	/** Test-only: land directly in `preview_building` with the ask's persisted
	 * inputs, so the preview-poll path can be exercised without dispatching the
	 * (runtime-less in tests) investigate agent through fixing. */
	async debugPrimePreviewBuilding(
		anchorNumber: number,
		notes: string,
		kind: Kind = "bug",
	): Promise<void> {
		await Promise.all([
			this.ctx.storage.put(STORAGE.state, "preview_building" satisfies StateId),
			this.ctx.storage.put(STORAGE.kind, kind),
			this.ctx.storage.put(STORAGE.anchorNumber, anchorNumber),
			this.ctx.storage.put(STORAGE.previewNotes, notes),
		]);
	}

	/** Test-only: land in `fixing` without dispatching the investigate agent. */
	async debugPrimeFixing(anchorNumber: number): Promise<void> {
		await Promise.all([
			this.ctx.storage.put(STORAGE.state, "fixing" satisfies StateId),
			this.ctx.storage.put(STORAGE.kind, "enhancement" satisfies Kind),
			this.ctx.storage.put(STORAGE.anchorNumber, anchorNumber),
		]);
	}

	/** Test-only: land in `failed` without dispatching an investigate run. */
	async debugPrimeFailed(anchorNumber: number): Promise<void> {
		await Promise.all([
			this.ctx.storage.put(STORAGE.state, "failed" satisfies StateId),
			this.ctx.storage.put(STORAGE.kind, "enhancement" satisfies Kind),
			this.ctx.storage.put(STORAGE.anchorNumber, anchorNumber),
		]);
	}

	/** Test-only: inject dispatch recovery state without invoking Flue. */
	async debugSetPendingDispatch(input: {
		runId: string;
		agentId: string;
		deliveryId: string;
		startedAt: number;
		dispatchError?: string;
		dispatchAttempt?: string;
	}): Promise<void> {
		await Promise.all([
			this.ctx.storage.put(STORAGE.state, "working" satisfies StateId),
			this.ctx.storage.put(STORAGE.currentRunId, input.runId),
			this.ctx.storage.put(STORAGE.currentRunStartedAt, input.startedAt),
			this.ctx.storage.put(STORAGE.currentAgentId, input.agentId),
			this.ctx.storage.put(STORAGE.pendingDispatch, {
				runId: input.runId,
				agentId: input.agentId,
				deliveryId: input.deliveryId,
				issueNumber: 999,
				mode: "implement",
				arg: null,
				issueTitle: "Test issue",
				issueBody: "Test body",
				previousBranchSha: null,
				context: "## Triggering directive (authoritative)\n\nTest directive",
			} satisfies PendingDispatch),
			...(input.dispatchError
				? [this.ctx.storage.put(STORAGE.currentDispatchError, input.dispatchError)]
				: []),
			...(input.dispatchAttempt
				? [this.ctx.storage.put(STORAGE.currentDispatchAttempt, input.dispatchAttempt)]
				: []),
		]);
	}

	/** Test-only: inject a rejected resume launch and its blocked projection. */
	async debugSetPendingResume(input: {
		runId: string;
		agentId: string;
		deliveryId: string;
		startedAt: number;
		dispatchError?: string;
		dispatchAttempt?: string;
	}): Promise<void> {
		const checkpoint: ResumableRunCheckpoint = {
			runId: input.runId,
			agentId: input.agentId,
			mode: "implement",
			state: "fixing",
			attemptStartedAt: input.startedAt - 60 * 60_000,
			timedOutAt: input.startedAt,
			summary: "The saved run still needs verification.",
		};
		await Promise.all([
			this.ctx.storage.put(STORAGE.state, "fixing" satisfies StateId),
			this.ctx.storage.put(STORAGE.kind, "enhancement" satisfies Kind),
			this.ctx.storage.put(STORAGE.anchorNumber, 999),
			this.ctx.storage.put(STORAGE.currentRunId, input.runId),
			this.ctx.storage.put(STORAGE.currentRunMode, "implement" satisfies InvestigationMode),
			this.ctx.storage.put(STORAGE.currentRunStartedAt, input.startedAt),
			this.ctx.storage.put(STORAGE.currentAgentId, input.agentId),
			this.ctx.storage.put(STORAGE.resumableRun, checkpoint),
			this.ctx.storage.put(STORAGE.pendingResume, {
				checkpoint,
				directive: null,
				deliveryId: input.deliveryId,
				dryRun: false,
			} satisfies PendingResume),
			this.ctx.storage.put(STORAGE.pendingSideEffects, [
				{
					id: "pending-resume-projection",
					deliveryId: input.deliveryId,
					runId: input.runId,
					settlesRun: false,
					anchorNumber: 999,
					addLabels: ["bot:fixing"],
					removeLabels: ["bot:failed"],
					commentBody: "",
					commentMarker: "<!-- emdashbot-event:pending-resume-projection -->",
					commentMayExist: false,
				} satisfies PendingSideEffect,
			]),
			...(input.dispatchError
				? [this.ctx.storage.put(STORAGE.currentDispatchError, input.dispatchError)]
				: []),
			...(input.dispatchAttempt
				? [this.ctx.storage.put(STORAGE.currentDispatchAttempt, input.dispatchAttempt)]
				: []),
		]);
	}

	/** Test-only: confirm a synthetic resume admission receipt. */
	async debugConfirmPendingResumeReceipt(submissionId: string): Promise<void> {
		const [pending, attemptId] = await Promise.all([
			this.ctx.storage.get<PendingResume>(STORAGE.pendingResume),
			this.ctx.storage.get<string>(STORAGE.currentDispatchAttempt),
		]);
		if (!pending || !attemptId) throw new Error("no pending resume admission");
		await this.persistResumeReceipt(pending, attemptId, submissionId);
	}
}

export type EventOutcome =
	| { kind: "noop"; reason: string }
	| { kind: "readonly"; state: StateId | null; event: EventId }
	| {
			kind: "transition";
			decision: Extract<Decision, { kind: "transition" }>;
			sideEffectError?: string;
			runError?: string;
	  }
	| { kind: "duplicate"; deliveryId: string }
	| { kind: "stale-run"; runId: string; currentRunId: string | null }
	| { kind: "inert"; state: StateId }
	| { kind: "recovered" };

export type EnqueueOutcome =
	| { kind: "admitted"; id: string }
	| { kind: "duplicate"; deliveryId: string };

/** One preview poll's outcome: idle (not building), waiting (before next poll),
 * polling (probed, not yet published), ready, or failed (budget exhausted). */
export type PreviewPollOutcome = "idle" | "waiting" | "polling" | "ready" | "failed";

export interface TickOutcome {
	ranAt: number;
	processedInboxItem: boolean;
	inboxError: string | null;
	sentDeadlineWarning: boolean;
	droppedStaleRun: boolean;
	recoveryError: string | null;
	labelDrift: { added: number; removed: number } | null;
	expiredReporterWait: boolean;
	previewPoll: PreviewPollOutcome;
}

export type CleanupOutcome =
	| { kind: "reaped" }
	| { kind: "skipped"; reason: string }
	| { kind: "error"; error: string };

class ClassifierProcessingError extends Error {
	constructor(reason: string) {
		super(`classifier failed: ${reason}`);
		this.name = "ClassifierProcessingError";
	}
}

function sanitizePublicProgressText(value: string, limit: number): string {
	const normalized = value
		.replaceAll(/[\r\n\t]+/g, " ")
		.replaceAll(/\s{2,}/g, " ")
		.trim();
	return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseInvestigateMode(value: string): InvestigationMode | null {
	if (
		value === "repro" ||
		value === "implement" ||
		value === "revise" ||
		value === "diagnose" ||
		value === "fix"
	)
		return value;
	return null;
}

function parseKind(value: string): Kind | null {
	if (value === "bug" || value === "enhancement" || value === "task") return value;
	return null;
}

function renderComment(
	decision: Extract<Decision, { kind: "transition" }>,
	anchorNumber: number,
	agentSummary?: string,
	failure?: { runId?: string; failureStage?: string },
	previewPackage?: string,
): string {
	return renderAgentComment(decision, anchorNumber, agentSummary, failure, previewPackage);
}
