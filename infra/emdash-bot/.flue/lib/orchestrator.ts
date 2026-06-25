// Per-issue Orchestrator Durable Object.
//
// One instance per anchoring issue (`idFromName("issue-" + number)`). Holds
// the canonical state for that issue's bot lifecycle. Labels on GitHub are a
// projection of this state, not the source of truth -- which lets us recover
// from label drift, drop stale agent results, and keep cross-event ordering
// without the workflow races that plagued the Actions-based implementation
// (PR #1606 cycles 4 / 6).
//
// This commit is the SKELETON: class shape, storage layout, and the pure
// resolve-and-record path. GitHub side effects (label flip, comment, PR ops)
// and workflow invocation (`runAction`) land in the next commit alongside the
// webhook handler, since they share the GitHub App token.
//
// Trust model: this DO holds NO string-shaped credentials. Workflow invocation
// uses Flue's binding-based `invoke()`; GitHub calls go through a small client
// that receives the App token from a credential-issuing helper, not the
// environment directly. The agent's container never sees either.

import { DurableObject } from "cloudflare:workers";

import { STATES, type EventId, type Kind, type StateId } from "./machine.js";
import { type Decision, outcomeFromResult, resolve } from "./router.js";

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
	/**
	 * Delivery id from the webhook. Stored in the event log for idempotency
	 * checks and debugging. GitHub webhooks may redeliver; the orchestrator
	 * dedupes by this id.
	 */
	readonly deliveryId?: string;
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

/**
 * Storage keys live in one namespace per DO instance, so we prefix to avoid
 * collisions with anything Flue or the runtime might add.
 */
const STORAGE = {
	state: "o:state",
	kind: "o:kind",
	currentRunId: "o:currentRunId",
	prNumber: "o:prNumber",
	eventLog: "o:eventLog",
	seenDeliveries: "o:seenDeliveries",
} as const;

/** Bounded delivery-id dedupe window. */
const DELIVERY_DEDUPE_LIMIT = 64;

export class OrchestratorDO extends DurableObject<Env> {
	/**
	 * Entry point from the webhook handler. Single-threaded per DO instance,
	 * so concurrent events for the same issue queue here -- the PR-comment /
	 * issue-comment race from PR #1606 cycle 4 cannot occur.
	 *
	 * This skeleton version resolves the decision and persists state. The full
	 * version also runs side effects (label flip, comment, PR ops) and
	 * invokes the investigate workflow for transitions with `action`.
	 */
	async event(input: NormalizedEvent): Promise<EventOutcome> {
		// Webhook idempotency. GitHub may redeliver any delivery; dedupe by id.
		if (input.deliveryId) {
			const seen = await this.isDeliverySeen(input.deliveryId);
			if (seen) return { kind: "duplicate", deliveryId: input.deliveryId };
		}

		// Classification path is wired in the next commit. For now, an event
		// without a resolved verb is treated as "nothing to do" -- the webhook
		// either deterministically resolved it or it shouldn't have been
		// dispatched yet.
		if (input.needsClassify || input.event === null) {
			return { kind: "classify-pending" };
		}

		const decision = resolve({
			labels: input.labels,
			event: input.event,
			arg: input.arg,
			actor: input.actor,
		});

		if (input.deliveryId) await this.recordDelivery(input.deliveryId);

		if (decision.kind === "noop") return { kind: "noop", reason: decision.reason };
		if (decision.kind === "readonly") {
			return { kind: "readonly", state: decision.state, event: decision.event };
		}

		// Transition: persist new state. Side effects (label flip, comment, PR
		// ops, workflow invocation) land in the next commit. We record the
		// decision so a partial follow-up commit can replay it.
		await this.persistDecision(decision, input);
		return { kind: "transition", decision };
	}

	/**
	 * Map an investigate workflow's result to a follow-up machine event.
	 * Late-result discard: if the run id no longer matches the current
	 * in-flight run, the issue was advanced or reset since the run started;
	 * drop the result silently. Mirrors PR #1606's cycle 6/7 fix but operates
	 * on DO state, not labels.
	 */
	async applyAgentResult(input: {
		runId: string;
		result: AgentResult;
		pushed: boolean;
		ok: boolean;
	}): Promise<EventOutcome> {
		const currentRunId = await this.ctx.storage.get<string>(STORAGE.currentRunId);
		if (currentRunId !== input.runId) {
			return { kind: "stale-run", runId: input.runId, currentRunId: currentRunId ?? null };
		}

		const state = await this.ctx.storage.get<StateId>(STORAGE.state);
		if (state && INERT_STATES.has(state)) {
			return { kind: "inert", state };
		}

		const event = outcomeFromResult({
			ok: input.ok,
			result: input.result,
			pushed: input.pushed,
		});

		// Re-enter the orchestrator's main loop with the synthesized event.
		// `actor: "system"` is the bot itself reporting back from the agent;
		// the machine permits `agent.*` events from system only.
		const labels = await this.projectLabels();
		return this.event({
			event,
			arg: null,
			actor: "system",
			labels,
			needsClassify: false,
		});
	}

	/**
	 * Cron-driven cleanup. Recovers stale runs (currentRunId set but the
	 * workflow never reported back), warns about abandoned awaiting states,
	 * and prunes the event log. Implementation lands with the cron wiring
	 * in a later commit; for now this is a documented no-op so the cron
	 * handler can call it without conditional branches.
	 */
	async tick(): Promise<void> {
		// Intentionally empty -- placeholder for cron-driven recovery.
	}

	// ---------------- Private helpers ----------------

	private async persistDecision(
		decision: Extract<Decision, { kind: "transition" }>,
		input: NormalizedEvent,
	): Promise<void> {
		const ops: Promise<unknown>[] = [
			this.ctx.storage.put(STORAGE.state, decision.to),
			this.appendEventLog({
				t: Date.now(),
				event: decision.event,
				actor: input.actor,
				from: decision.from === "conflicting" ? "conflicting" : decision.from,
				to: decision.to,
				...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
			}),
		];
		// `addLabels` always includes the new state label; if it also includes
		// a kind label, that's the entry-transition path -- persist the kind so
		// later events have a non-label source of truth.
		const kindLabel = decision.addLabels.find((l) => l.startsWith("bot:") && l !== decision.addLabel);
		if (kindLabel) {
			const kind = kindLabel.slice("bot:".length) as Kind;
			ops.push(this.ctx.storage.put(STORAGE.kind, kind));
		}
		await Promise.all(ops);
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

	private async appendEventLog(entry: EventLogEntry): Promise<void> {
		const existing = (await this.ctx.storage.get<EventLogEntry[]>(STORAGE.eventLog)) ?? [];
		existing.push(entry);
		const trimmed =
			existing.length > EVENT_LOG_LIMIT ? existing.slice(-EVENT_LOG_LIMIT) : existing;
		await this.ctx.storage.put(STORAGE.eventLog, trimmed);
	}

	private async isDeliverySeen(deliveryId: string): Promise<boolean> {
		const seen = (await this.ctx.storage.get<string[]>(STORAGE.seenDeliveries)) ?? [];
		return seen.includes(deliveryId);
	}

	private async recordDelivery(deliveryId: string): Promise<void> {
		const seen = (await this.ctx.storage.get<string[]>(STORAGE.seenDeliveries)) ?? [];
		if (seen.includes(deliveryId)) return;
		seen.push(deliveryId);
		const trimmed =
			seen.length > DELIVERY_DEDUPE_LIMIT ? seen.slice(-DELIVERY_DEDUPE_LIMIT) : seen;
		await this.ctx.storage.put(STORAGE.seenDeliveries, trimmed);
	}

	// ---------------- Read-only inspection (test + debug) ----------------

	async getPersistedState(): Promise<PersistedState> {
		const [state, kind, currentRunId, prNumber] = await Promise.all([
			this.ctx.storage.get<StateId>(STORAGE.state),
			this.ctx.storage.get<Kind>(STORAGE.kind),
			this.ctx.storage.get<string>(STORAGE.currentRunId),
			this.ctx.storage.get<number>(STORAGE.prNumber),
		]);
		return {
			state: state ?? null,
			kind: kind ?? null,
			currentRunId: currentRunId ?? null,
			prNumber: prNumber ?? null,
		};
	}

	async getEventLog(): Promise<readonly EventLogEntry[]> {
		return (await this.ctx.storage.get<EventLogEntry[]>(STORAGE.eventLog)) ?? [];
	}
}

export type EventOutcome =
	| { kind: "noop"; reason: string }
	| { kind: "readonly"; state: StateId | null; event: EventId }
	| { kind: "transition"; decision: Extract<Decision, { kind: "transition" }> }
	| { kind: "duplicate"; deliveryId: string }
	| { kind: "classify-pending" }
	| { kind: "stale-run"; runId: string; currentRunId: string | null }
	| { kind: "inert"; state: StateId };
