// Per-issue Orchestrator Durable Object.
//
// One instance per anchoring issue (`idFromName("issue-" + number)`). Holds
// the canonical state for that issue's bot lifecycle. Labels on GitHub are a
// projection of this state, not the source of truth.

import { dispatch } from "@flue/runtime";
import { DurableObject } from "cloudflare:workers";

import { Investigate } from "../agents/investigate.js";
import { classifyComment, type ClassifyResult } from "./classifier-client.js";
import { renderAgentComment, renderReadonlyReply, shouldPostReadonlyReply } from "./comments.js";
import {
	addLabels,
	closePullRequest,
	createPullRequest,
	getBranchSha,
	getIssue,
	getIssueLabels,
	getOpenPullRequest,
	hasIssueCommentMarker,
	mintInstallationToken,
	postIssueComment,
	readAppCreds,
	readRepoContext,
	removeLabels,
} from "./github.js";
import { STATES, type EventId, type Kind, type StateId } from "./machine.js";
import {
	currentState,
	type Decision,
	type InvestigationMode,
	outcomeFromResult,
	resolve,
} from "./router.js";
import { DeadlineExceededError, withDeadline } from "./sandbox-deadline.js";

/**
 * Inert states cannot be advanced by a late-arriving agent result. If a run
 * lands here, the issue was reset, declined, or hand-taken since it started;
 * discard the result rather than re-animate a dead lifecycle. Mirrors the
 * cycle 6/7 fix from PR #1606, but operating on DO state instead of labels.
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
	/** Internal callback metadata: this event's projection completes the run. */
	readonly settlesRunId?: string;
}

/**
 * Agent return shape we care about. The router's `outcomeFromResult` does the
 * actual mapping; this is just the structural contract.
 */
export interface AgentResult {
	readonly skipped?: boolean;
	readonly reproduced?: boolean;
	readonly fixed?: boolean;
	readonly verdict?: string;
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
} as const;

const TICK_INTERVAL_MS = 60 * 60 * 1000;
const STALE_RUN_THRESHOLD_MS = 30 * 60 * 1000;
const DISPATCH_TIMEOUT_MS = 30_000;
const INBOX_RETRY_MS = 60_000;
const INBOX_BATCH_LIMIT = 10;
const CLASSIFIER_MAX_ATTEMPTS = 3;
const CLASSIFIER_TEXT_LIMIT = 16_000;

interface CachedToken {
	token: string;
	/** Unix ms; tokens are valid ~1h, we expire 5m early. */
	expiresAt: number;
}

interface PreparedInvestigation {
	runId: string;
	agentId: string;
	issueNumber: number;
	mode: "repro" | "implement" | "revise";
	arg: string | null;
	issueTitle: string;
	issueBody: string;
	previousBranchSha: string | null;
}

interface PendingDispatch extends PreparedInvestigation {
	readonly deliveryId?: string;
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
}

/** Bounded delivery-id dedupe window. */
const DELIVERY_DEDUPE_LIMIT = 64;

export class OrchestratorDO extends DurableObject<Env> {
	private operationTail: Promise<void> = Promise.resolve();

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
	 * so concurrent events for the same issue queue here -- the PR-comment /
	 * issue-comment race from PR #1606 cycle 4 cannot occur.
	 *
	 * This skeleton version resolves the decision and persists state. The full
	 * version also runs side effects (label flip, comment, PR ops) and
	 * invokes the investigate workflow for transitions with `action`.
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
		await this.drainPendingSideEffects();
		if (resumedDispatch && input.deliveryId) {
			await this.recordDelivery(input.deliveryId);
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

		const decision = resolve({
			labels,
			event: resolvedEvent,
			arg: resolvedArg,
			actor: input.actor,
		});

		if (decision.kind === "noop") {
			if (input.deliveryId) await this.recordDelivery(input.deliveryId);
			return { kind: "noop", reason: decision.reason };
		}
		if (decision.kind === "readonly") {
			if (shouldPostReadonlyReply(input.dryRun)) await this.postReadonlyReply(decision, input);
			if (input.deliveryId) await this.recordDelivery(input.deliveryId);
			return { kind: "readonly", state: decision.state, event: decision.event };
		}

		let runError: string | null = null;
		let preparedInvestigation: PreparedInvestigation | null = null;
		if (decision.action?.startsWith("investigate.")) {
			const preparation = await this.prepareInvestigation(decision, resolvedArg ?? input.arg);
			if (typeof preparation === "string") runError = preparation;
			else preparedInvestigation = preparation;
		}

		if (decision.action && !decision.action.startsWith("investigate.")) {
			runError = await this.runAction(decision);
		}
		if (runError) {
			throw new Error(runError);
		}

		const sideEffectId = await this.persistDecision(decision, input, preparedInvestigation);
		await this.armAlarm();

		if (preparedInvestigation) {
			runError = await this.dispatchInvestigation(preparedInvestigation);
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
	 * Map an investigate workflow's result to a follow-up machine event.
	 * Late-result discard: if the run id no longer matches the current
	 * in-flight run, the issue was advanced or reset since the run started;
	 * drop the result silently. Mirrors PR #1606's cycle 6/7 fix but operates
	 * on DO state, not labels.
	 */
	applyAgentResult(input: {
		runId: string;
		result: AgentResult;
		pushed: boolean;
		ok: boolean;
	}): Promise<EventOutcome> {
		return this.runExclusive(() => this.processAgentResult(input));
	}

	private async processAgentResult(input: {
		runId: string;
		result: AgentResult;
		pushed: boolean;
		ok: boolean;
	}): Promise<EventOutcome> {
		const [currentRunId, currentRunMode] = await Promise.all([
			this.ctx.storage.get<string>(STORAGE.currentRunId),
			this.ctx.storage.get<InvestigationMode>(STORAGE.currentRunMode),
		]);
		if (currentRunId !== input.runId) {
			return { kind: "stale-run", runId: input.runId, currentRunId: currentRunId ?? null };
		}
		await this.confirmDispatchAdmission(input.runId);
		const settledRuns = await this.drainPendingSideEffects();
		if (settledRuns.has(input.runId)) return { kind: "recovered" };

		const state = await this.ctx.storage.get<StateId>(STORAGE.state);
		if (state && INERT_STATES.has(state)) {
			await this.clearRun(input.runId);
			return { kind: "inert", state };
		}

		const event = outcomeFromResult({
			ok: input.ok,
			result: input.result,
			pushed: input.pushed,
			mode: currentRunMode,
		});

		const labels = await this.projectLabels();
		const agentSummary =
			typeof input.result?.summary === "string" ? input.result.summary : undefined;
		const outcome = await this.processEvent({
			event,
			arg: null,
			actor: "system",
			labels,
			needsClassify: false,
			settlesRunId: input.runId,
			...(agentSummary ? { agentSummary } : {}),
		});
		await this.clearRun(input.runId);
		return outcome;
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
		let droppedStaleRun = false;
		let recoveryError: string | null = null;
		try {
			await this.recoverRejectedDispatch();
			droppedStaleRun = await this.recoverStaleRun(now);
		} catch (error) {
			recoveryError = error instanceof Error ? error.message : String(error);
			console.error("[orchestrator] stale-run recovery failed", { error: recoveryError });
		}
		const labelDrift = await this.reconcileLabels();

		return {
			ranAt: now,
			processedInboxItem,
			inboxError,
			droppedStaleRun,
			recoveryError,
			labelDrift,
		};
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

	private async armAlarm(): Promise<void> {
		const [current, runStartedAt, inbox, pendingSideEffects] = await Promise.all([
			this.ctx.storage.getAlarm(),
			this.ctx.storage.get<number>(STORAGE.currentRunStartedAt),
			this.ctx.storage.get<InboxEntry[]>(STORAGE.inbox),
			this.ctx.storage.get<PendingSideEffect[]>(STORAGE.pendingSideEffects),
		]);
		const now = Date.now();
		const desired =
			inbox?.length || pendingSideEffects?.length
				? now + INBOX_RETRY_MS
				: runStartedAt
					? Math.max(now + 1_000, runStartedAt + STALE_RUN_THRESHOLD_MS)
					: now + TICK_INTERVAL_MS;
		if (current === null || current <= now || current > desired) {
			await this.ctx.storage.setAlarm(desired);
		}
	}

	private async recoverStaleRun(now: number): Promise<boolean> {
		const startedAt = await this.ctx.storage.get<number>(STORAGE.currentRunStartedAt);
		if (startedAt === undefined) return false;
		if (now - startedAt < STALE_RUN_THRESHOLD_MS) return false;
		const runId = await this.ctx.storage.get<string>(STORAGE.currentRunId);
		const agentId = await this.ctx.storage.get<string>(STORAGE.currentAgentId);
		const pendingDispatch = await this.ctx.storage.get<PendingDispatch>(STORAGE.pendingDispatch);
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

		// Commit the failed transition before deleting retry evidence. If this
		// throws, the run markers remain and the next alarm retries recovery.
		const labels = await this.projectLabels();
		await this.processEvent({
			event: "agent.failed",
			arg: null,
			actor: "system",
			labels,
			needsClassify: false,
			agentSummary: "I couldn't complete this run before its durability deadline.",
			settlesRunId: runId,
		});
		await this.clearRun(runId);
		if (pendingDispatch?.runId === runId && pendingDispatch.deliveryId) {
			await this.recordDelivery(pendingDispatch.deliveryId);
		}
		return true;
	}

	private async recoverRejectedDispatch(): Promise<string | null> {
		const [pending, dispatchError] = await Promise.all([
			this.ctx.storage.get<PendingDispatch>(STORAGE.pendingDispatch),
			this.ctx.storage.get<string>(STORAGE.currentDispatchError),
		]);
		if (!pending || !dispatchError) return null;

		await this.discardLaunchSideEffects(pending.runId);
		const labels = await this.projectLabels();
		await this.processEvent(
			{
				event: "agent.failed",
				arg: null,
				actor: "system",
				labels,
				needsClassify: false,
				agentSummary: `I couldn't start this run: ${dispatchError}`,
				settlesRunId: pending.runId,
			},
			false,
		);
		await this.clearRun(pending.runId);
		if (pending.deliveryId) await this.recordDelivery(pending.deliveryId);
		return pending.deliveryId ?? null;
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
		const result: ClassifyResult = await classifyComment({
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
		if (decision.action === "closePr") {
			return this.runClosePr(creds, repo);
		}
		return `unknown action "${decision.action}"`;
	}

	private async prepareInvestigation(
		decision: Extract<Decision, { kind: "transition" }>,
		arg: string | null,
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
			const [issue, previousBranchSha] = await Promise.all([
				getIssue(token, repo, anchorNumber),
				getBranchSha(token, repo, `bot/fix-${anchorNumber}`),
			]);
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
				},
			}),
		);
		const persistReceipt = async (receipt: Awaited<typeof dispatchPromise>) => {
			await this.ctx.storage.transaction(async (transaction) => {
				if ((await transaction.get<string>(STORAGE.currentRunId)) !== prepared.runId) return;
				if ((await transaction.get<string>(STORAGE.currentDispatchAttempt)) !== attemptId) return;
				await transaction.put(STORAGE.currentDispatchId, receipt.dispatchId);
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
	 * Open the bot PR from the pushed fix branch (`bot/fix-<n>`). Phase 1
	 * sees no branches yet -- the investigate workflow's push step is
	 * Phase 2 -- so this returns an error string that surfaces as runError
	 * in the EventOutcome. The DO still advances state.
	 */
	private async runOpenPr(
		creds: Parameters<typeof mintInstallationToken>[0],
		repo: Parameters<typeof createPullRequest>[1],
		anchorNumber: number,
	): Promise<string | null> {
		const token = await this.getInstallationToken(creds);
		const headBranch = `bot/fix-${anchorNumber}`;
		try {
			const created =
				(await getOpenPullRequest(token, repo, headBranch)) ??
				(await createPullRequest(token, repo, {
					headBranch,
					baseBranch: "main",
					title: `Fix #${anchorNumber}`,
					body: `Fixes #${anchorNumber}.\n\nAutomated PR opened by emdashbot.`,
				}));
			await this.ctx.storage.put(STORAGE.prNumber, created.number);
			return null;
		} catch (err) {
			return `openPr failed: ${errorMessage(err)}`;
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
		const id = await this.persistStandaloneSideEffect({
			anchorNumber,
			commentBody: renderReadonlyReply(state),
			...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
		});
		await this.armAlarm();
		await this.drainPendingSideEffects();
		if (await this.hasPendingSideEffect(id)) {
			throw new Error("readonly reply is queued behind an earlier GitHub projection");
		}
	}

	// ---------------- Side effects (GitHub) ----------------

	private async flushPendingSideEffect(id: string): Promise<void> {
		let pending = (
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
		await addLabels(token, repo, pending.anchorNumber, pending.addLabels);
		await removeLabels(token, repo, pending.anchorNumber, pending.removeLabels);

		if (pending.commentBody) {
			let exists = false;
			if (pending.commentMayExist) {
				exists = await hasIssueCommentMarker(
					token,
					repo,
					pending.anchorNumber,
					pending.commentMarker,
				);
			} else {
				await this.markCommentMayExist(pending.id);
				pending = { ...pending, commentMayExist: true };
			}
			if (!exists) {
				await postIssueComment(
					token,
					repo,
					pending.anchorNumber,
					`${pending.commentBody}\n\n${pending.commentMarker}`,
				);
			}
		}

		await this.completePendingSideEffect(pending);
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
	): Promise<string | null> {
		const sideEffectId = input.dryRun ? null : crypto.randomUUID();
		return this.ctx.storage.transaction(async (transaction) => {
			const existing = (await transaction.get<EventLogEntry[]>(STORAGE.eventLog)) ?? [];
			const entry: EventLogEntry = {
				t: Date.now(),
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
			];
			const kindLabel = decision.addLabels.find(
				(label) => label.startsWith("bot:") && label !== decision.addLabel,
			);
			if (kindLabel) {
				const kind = parseKind(kindLabel.slice("bot:".length));
				if (kind) puts.push(transaction.put(STORAGE.kind, kind));
			}
			if (preparedInvestigation) {
				puts.push(
					transaction.put(STORAGE.currentRunId, preparedInvestigation.runId),
					transaction.put(STORAGE.currentRunMode, preparedInvestigation.mode),
					transaction.put(STORAGE.currentRunStartedAt, Date.now()),
					transaction.put(STORAGE.currentAgentId, preparedInvestigation.agentId),
					transaction.put(STORAGE.pendingDispatch, {
						...preparedInvestigation,
						...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
					} satisfies PendingDispatch),
				);
			}
			const anchorNumber =
				input.anchorNumber ?? (await transaction.get<number>(STORAGE.anchorNumber));
			const effectRunId = preparedInvestigation?.runId ?? input.settlesRunId;
			if (sideEffectId && anchorNumber !== undefined) {
				const pending =
					(await transaction.get<PendingSideEffect[]>(STORAGE.pendingSideEffects)) ?? [];
				puts.push(
					transaction.put(STORAGE.pendingSideEffects, [
						...pending,
						{
							id: sideEffectId,
							...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
							...(effectRunId ? { runId: effectRunId } : {}),
							settlesRun: input.settlesRunId !== undefined,
							anchorNumber,
							addLabels: decision.addLabels,
							removeLabels: decision.removeLabels,
							commentBody: renderComment(decision, anchorNumber, input.agentSummary),
							commentMarker: `<!-- emdashbot-event:${sideEffectId} -->`,
							commentMayExist: false,
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
				transaction.delete(STORAGE.currentAgentId),
				transaction.delete(STORAGE.currentDispatchId),
				transaction.delete(STORAGE.currentDispatchError),
				transaction.delete(STORAGE.currentDispatchAttempt),
				transaction.delete(STORAGE.abortConfirmedRunId),
			]);
			const pending = await transaction.get<PendingDispatch>(STORAGE.pendingDispatch);
			if (pending?.runId === expectedRunId) await transaction.delete(STORAGE.pendingDispatch);
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

	private async drainPendingSideEffects(): Promise<Set<string>> {
		const settledRuns = new Set<string>();
		for (;;) {
			const [effects, pendingDispatch] = await Promise.all([
				this.ctx.storage.get<PendingSideEffect[]>(STORAGE.pendingSideEffects),
				this.ctx.storage.get<PendingDispatch>(STORAGE.pendingDispatch),
			]);
			const effect = effects?.[0];
			if (!effect) return settledRuns;
			if (!effect.settlesRun && effect.runId === pendingDispatch?.runId) return settledRuns;

			await this.flushPendingSideEffect(effect.id);
			if (effect.settlesRun && effect.runId) settledRuns.add(effect.runId);
		}
	}

	private async confirmDispatchAdmission(runId: string): Promise<void> {
		await this.ctx.storage.transaction(async (transaction) => {
			const pending = await transaction.get<PendingDispatch>(STORAGE.pendingDispatch);
			if (pending?.runId !== runId) return;
			if (pending.deliveryId) {
				const seen = (await transaction.get<string[]>(STORAGE.seenDeliveries)) ?? [];
				if (!seen.includes(pending.deliveryId)) {
					await transaction.put(
						STORAGE.seenDeliveries,
						[...seen, pending.deliveryId].slice(-DELIVERY_DEDUPE_LIMIT),
					);
				}
			}
			await Promise.all([
				transaction.delete(STORAGE.pendingDispatch),
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
					transaction.delete(STORAGE.currentAgentId),
					transaction.delete(STORAGE.currentDispatchId),
					transaction.delete(STORAGE.currentDispatchError),
					transaction.delete(STORAGE.currentDispatchAttempt),
					transaction.delete(STORAGE.pendingDispatch),
					transaction.delete(STORAGE.abortConfirmedRunId),
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
			...(agentId ? [this.ctx.storage.put(STORAGE.currentAgentId, agentId)] : []),
			...(mode ? [this.ctx.storage.put(STORAGE.currentRunMode, mode)] : []),
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
			} satisfies PendingDispatch),
			...(input.dispatchError
				? [this.ctx.storage.put(STORAGE.currentDispatchError, input.dispatchError)]
				: []),
			...(input.dispatchAttempt
				? [this.ctx.storage.put(STORAGE.currentDispatchAttempt, input.dispatchAttempt)]
				: []),
		]);
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

export interface TickOutcome {
	ranAt: number;
	processedInboxItem: boolean;
	inboxError: string | null;
	droppedStaleRun: boolean;
	recoveryError: string | null;
	labelDrift: { added: number; removed: number } | null;
}

class ClassifierProcessingError extends Error {
	constructor(reason: string) {
		super(`classifier failed: ${reason}`);
		this.name = "ClassifierProcessingError";
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseInvestigateMode(value: string): "repro" | "implement" | "revise" | null {
	if (value === "repro" || value === "implement" || value === "revise") return value;
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
): string {
	return renderAgentComment(decision, anchorNumber, agentSummary);
}
