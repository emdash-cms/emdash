// Per-issue Orchestrator Durable Object.
//
// One instance per anchoring issue (`idFromName("issue-" + number)`). Holds
// the canonical state for that issue's bot lifecycle. Labels on GitHub are a
// projection of this state, not the source of truth.

import { DurableObject } from "cloudflare:workers";

import { classifyComment, type ClassifyResult } from "./classifier-client.js";
import {
	addLabels,
	mintInstallationToken,
	postIssueComment,
	readAppCreds,
	readRepoContext,
	removeLabels,
} from "./github.js";
import { STATES, type EventId, type Kind, type StateId } from "./machine.js";
import { currentState, type Decision, outcomeFromResult, resolve } from "./router.js";

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
	anchorNumber: "o:anchorNumber",
	tokenCache: "o:tokenCache",
} as const;

interface CachedToken {
	token: string;
	/** Unix ms; tokens are valid ~1h, we expire 5m early. */
	expiresAt: number;
}

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
		if (input.deliveryId) {
			const seen = await this.isDeliverySeen(input.deliveryId);
			if (seen) return { kind: "duplicate", deliveryId: input.deliveryId };
		}

		if (input.anchorNumber !== undefined) {
			await this.ctx.storage.put(STORAGE.anchorNumber, input.anchorNumber);
		}

		let resolvedEvent: EventId | null = input.event;
		let resolvedArg: string | null = input.arg;
		if (input.needsClassify || resolvedEvent === null) {
			const classifyResult = await this.runClassifier(input);
			if (classifyResult.kind === "noop") {
				if (input.deliveryId) await this.recordDelivery(input.deliveryId);
				return classifyResult;
			}
			resolvedEvent = classifyResult.event;
			resolvedArg = classifyResult.arg;
		}

		const decision = resolve({
			labels: input.labels,
			event: resolvedEvent,
			arg: resolvedArg,
			actor: input.actor,
		});

		if (input.deliveryId) await this.recordDelivery(input.deliveryId);

		if (decision.kind === "noop") return { kind: "noop", reason: decision.reason };
		if (decision.kind === "readonly") {
			return { kind: "readonly", state: decision.state, event: decision.event };
		}

		// Side effects first: if the GitHub label flip fails, DO state stays
		// behind and the next event (or the reconciliation tick) retries.
		// Comment failure is non-fatal; DO state is still advanced.
		const sideEffectError = await this.applySideEffects(decision);
		await this.persistDecision(decision, input);
		return {
			kind: "transition",
			decision,
			...(sideEffectError ? { sideEffectError } : {}),
		};
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

	// ---------------- Classifier ----------------

	private async runClassifier(
		input: NormalizedEvent,
	): Promise<
		| { kind: "noop"; reason: string }
		| { event: EventId; arg: string | null; kind: "resolved" }
	> {
		const text = input.classifyText?.trim() ?? "";
		if (text === "") return { kind: "noop", reason: "no classify text" };
		if (input.anchorNumber === undefined) {
			return { kind: "noop", reason: "no anchor number for classifier call" };
		}
		const state = currentState(input.labels);
		const loopback = (this.ctx.exports as { default: Fetcher }).default;
		const result: ClassifyResult = await classifyComment(loopback, {
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
				return { kind: "noop", reason: `classifier error: ${result.error}` };
			case "event":
				return { kind: "resolved", event: result.event, arg: result.arg };
		}
	}

	// ---------------- Side effects (GitHub) ----------------

	/**
	 * Flip labels and post a transition comment on GitHub. Returns null on
	 * success, or an error reason on failure (DO state is NOT advanced if
	 * label flipping fails -- the caller bails before persistDecision). A
	 * comment failure logs but doesn't propagate.
	 *
	 * In dev mode (no app creds / no repo binding) returns "no-creds" without
	 * making any HTTP calls; the DO still advances its state so local flows
	 * can be exercised without GitHub access.
	 */
	private async applySideEffects(
		decision: Extract<Decision, { kind: "transition" }>,
	): Promise<string | null> {
		const creds = readAppCreds(this.env);
		const repo = readRepoContext(this.env);
		if (!creds || !repo) {
			console.log("[orchestrator] skipping side effects (creds or repo missing)", {
				event: decision.event,
				to: decision.to,
			});
			return null;
		}
		const anchorNumber = await this.ctx.storage.get<number>(STORAGE.anchorNumber);
		if (anchorNumber === undefined) {
			return "no anchor number; DO never received an anchored event";
		}

		const token = await this.getInstallationToken(creds);

		// Label flip: add new labels (state + maybe kind), then remove the rest.
		// addLabels is idempotent; removeLabel treats 404 as "already gone".
		try {
			await addLabels(token, repo, anchorNumber, decision.addLabels);
		} catch (err) {
			return `addLabels failed: ${(err as Error).message}`;
		}
		try {
			await removeLabels(token, repo, anchorNumber, decision.removeLabels);
		} catch (err) {
			return `removeLabels failed: ${(err as Error).message}`;
		}

		try {
			await postIssueComment(token, repo, anchorNumber, renderComment(decision));
		} catch (err) {
			console.error("[orchestrator] postComment failed (non-fatal):", err);
		}
		return null;
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
	| {
			kind: "transition";
			decision: Extract<Decision, { kind: "transition" }>;
			sideEffectError?: string;
	  }
	| { kind: "duplicate"; deliveryId: string }
	| { kind: "stale-run"; runId: string; currentRunId: string | null }
	| { kind: "inert"; state: StateId };

function renderComment(decision: Extract<Decision, { kind: "transition" }>): string {
	const action = decision.action ? ` (\`${decision.action}\`)` : "";
	const verb = decision.event.replace(/_/g, " ");
	return `Moved to \`${decision.to}\` on \`${verb}\`${action}.`;
}
