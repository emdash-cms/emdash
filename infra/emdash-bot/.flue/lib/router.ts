// Pure router logic for the emdashbot state machine.
//
// This module contains NO GitHub API calls and NO side effects. It maps
// (current labels, incoming event) to a decision the calling code then
// executes (swap labels, dispatch an agent action, post a reply). Keeping it
// pure makes it unit-testable in isolation.
//
// Ported from the Cloudflare Sandbox build's predecessor (the closed
// feat/bot-state-machine branch, where this was router.cjs consumed by
// github-script). Same logic, TypeScript-native imports, no CommonJS wrapper.

import {
	EVENTS,
	findTransition,
	KINDS,
	STATES,
	type Actor,
	type EventId,
	type Kind,
	type StateId,
} from "./machine.js";

const KIND_LABELS: string[] = KINDS.map((k) => `bot:${k}`);
const KIND_LABEL_SET = new Set(KIND_LABELS);
const STATE_LABEL_TO_ID = new Map<string, StateId>();
for (const [id, meta] of Object.entries(STATES)) {
	if (meta.label !== "" && isStateId(id)) {
		STATE_LABEL_TO_ID.set(meta.label, id);
	}
}
const STATE_LABELS: string[] = Object.values(STATES)
	.map((s) => s.label)
	.filter((l) => l !== "");
const STATE_LABEL_SET = new Set(STATE_LABELS);

function isStateId(value: string): value is StateId {
	return Object.hasOwn(STATES, value);
}

function isKind(value: string): value is Kind {
	return (KINDS as readonly string[]).includes(value);
}

function isMachineActor(value: string): value is Actor {
	return value === "reporter" || value === "maintainer" || value === "system";
}

// Capture everything after a mention at the start of a line. The lookahead
// rejects longer handles while allowing a bare mention to resolve to status.
const MENTION_RE = /^[ \t]*@emdashbot(?=\s|$)([\s\S]*)/m;
const WS_RE = /\s+/g;
const UNDERSCORE_RE = /_/g;

/**
 * The state id encoded in a label set.
 *   - 0 state labels -> "unmanaged" (the implicit start; commands still work)
 *   - 1 state label  -> that state
 *   - >1             -> null (invalid; the linter will flag it)
 */
export function currentState(labelNames: readonly string[]): StateId | null {
	const found: StateId[] = [];
	for (const label of labelNames) {
		const id = STATE_LABEL_TO_ID.get(label);
		if (id !== undefined) found.push(id);
	}
	if (found.length === 0) return "unmanaged";
	return found.length === 1 ? (found[0] ?? null) : null;
}

/** The single kind ("bug"/...) encoded in a label set, or null. */
export function currentKind(labelNames: readonly string[]): Kind | null {
	const found: Kind[] = [];
	for (const label of labelNames) {
		if (!KIND_LABEL_SET.has(label)) continue;
		const kind = label.slice("bot:".length);
		if (isKind(kind)) found.push(kind);
	}
	return found.length === 1 ? (found[0] ?? null) : null;
}

const VERB_ALIASES: Record<string, EventId> = {
	"take over": "take_over",
	takeover: "take_over",
	"hand back": "hand_back",
	handback: "hand_back",
	confirmed: "confirm",
	verified: "confirm",
	fixed: "confirm",
};

/**
 * Extract the text after an `@emdashbot` mention at the start of a line.
 * Returns the trimmed remainder (possibly multi-line), or null if there is no
 * mention. This is the gate: no mention means the bot never acts.
 */
export function parseMention(body: string | null | undefined): string | null {
	if (!body) return null;
	const m = body.match(MENTION_RE);
	if (!m) return null;
	// Missing capture group means bare `@emdashbot` with no trailing text.
	return (m[1] ?? "").trim();
}

export interface ParsedCommand {
	event: EventId;
	arg: string | null;
}

/**
 * Parse a deterministic bare-verb command. The mention text must be EXACTLY a
 * known verb (after alias + whitespace normalization). Any extra word makes it
 * not a command -> null, so the caller hands it to the intent classifier.
 */
export function parseCommand(body: string | null | undefined): ParsedCommand | null {
	const text = parseMention(body);
	if (text === null) return null;
	const normalized = text.trim().toLowerCase().replace(WS_RE, " ");
	const aliased = VERB_ALIASES[normalized];
	const event = aliased ?? (isKnownEvent(normalized) ? normalized : null);
	if (!event) return null;
	return { event, arg: null };
}

/** True for hard-to-undo events excluded from free-text classification. */
export function isDestructive(event: string): boolean {
	if (!isKnownEvent(event)) return false;
	return Boolean(EVENTS[event].destructive);
}

export interface ClassifierCommand {
	event: EventId;
	description: string;
	arg: "directive" | "feedback" | null;
}

/**
 * The commands the intent classifier may choose from in a given state: the
 * state's offered commands minus destructive ones. Each carries its
 * description and whether it takes a free-text arg, for the classifier prompt.
 */
export function classifierCommands(state: StateId | null): ClassifierCommand[] {
	if (!state || !STATES[state]) return [];
	return STATES[state].offeredCommands
		.filter((e) => !isDestructive(e))
		.map((e) => ({
			event: e,
			description: EVENTS[e]?.description ?? "",
			arg: EVENTS[e]?.arg ?? null,
		}));
}

function isKnownEvent(event: string): event is EventId {
	return Object.hasOwn(EVENTS, event);
}

/** Re-export so callers have one router surface (machine.ts owns the impl). */
export { findTransition };

export type Decision =
	| { kind: "noop"; reason: string; from?: StateId | null }
	| { kind: "readonly"; state: StateId | null; event: EventId }
	| {
			kind: "transition";
			from: StateId | "conflicting";
			to: StateId;
			action: string | null;
			/** Singular form kept for callers that only handle one. */
			addLabel: string;
			/** Use this. Includes the kind label on entry transitions. */
			addLabels: string[];
			removeLabels: string[];
			event: EventId;
			arg: string | null;
	  };

export interface ResolveInput {
	labels: readonly string[];
	event: EventId;
	arg?: string | null;
	actor?: Actor | "other";
}

/**
 * Resolve an event against the current label set.
 *
 * Authorization (actor role) is checked here; the calling code (webhook
 * handler, Orchestrator DO) is responsible for actor classification but the
 * router enforces that the event's `actors` list includes the caller.
 */
export function resolve({ labels, event, arg, actor }: ResolveInput): Decision {
	const from = currentState(labels);
	const meta = EVENTS[event];
	if (!meta) return { kind: "noop", reason: `unknown event "${event}"` };
	// Actor check FIRST -- including for readonly events. Otherwise a drive-by
	// `@emdashbot status` from any GitHub user on a public issue would make
	// the bot post status replies it shouldn't.
	if (actor && (!isMachineActor(actor) || !meta.actors.includes(actor))) {
		return { kind: "noop", reason: `actor "${actor}" may not fire "${event}"` };
	}
	if (meta.readOnly) return { kind: "readonly", state: from, event };
	// `reset` is the explicit recovery path: it works even when the item has
	// conflicting state labels (currentState returned null), so the bot can
	// repair itself out of a half-applied label swap.
	if (event === "reset") {
		const toLabel = STATES.triage.label;
		return {
			kind: "transition",
			from: from ?? "conflicting",
			to: "triage",
			action: null,
			addLabel: toLabel,
			addLabels: [toLabel],
			removeLabels: STATE_LABELS.filter((l) => l !== toLabel),
			event,
			arg: arg ?? null,
		};
	}
	if (!from) return { kind: "noop", reason: "item has conflicting state labels" };
	const t = findTransition(from, event);
	if (!t) return { kind: "noop", reason: `no transition for ${from} + ${event}`, from };
	const toLabel = STATES[t.to].label;
	const removeLabels = STATE_LABELS.filter((l) => l !== toLabel);

	// Entry from unmanaged or triage: ensure the kind label matches the verb.
	// `unmanaged` is the implicit start (no labels); `triage` is the labeled
	// landing state after `reopen`, `hand_back`, or `reset`, which may carry a
	// stale kind from a previous lifecycle. If the issue carries no kind, apply
	// the event's defaultKind. If it carries a DIFFERENT kind than the verb
	// implies, the verb wins: drop the mismatched kind and apply the verb's.
	const addLabels: string[] = [toLabel];
	const isEntry = (from === "unmanaged" || from === "triage") && meta.defaultKind;
	if (isEntry && meta.defaultKind) {
		const existingKind = currentKind(labels);
		const wantedKind = meta.defaultKind;
		if (!existingKind) {
			addLabels.push(`bot:${wantedKind}`);
		} else if (existingKind !== wantedKind) {
			addLabels.push(`bot:${wantedKind}`);
			removeLabels.push(`bot:${existingKind}`);
		}
	}

	return {
		kind: "transition",
		from,
		to: t.to,
		action: t.action ?? null,
		addLabel: toLabel,
		addLabels,
		removeLabels,
		event,
		arg: arg ?? null,
	};
}

export type CommentDecision =
	| Decision
	| {
			kind: "classify";
			state: StateId | null;
			commands: ClassifierCommand[];
			text: string;
			actor?: Actor | "other";
	  };

export interface ResolveCommentInput {
	labels: readonly string[];
	body: string | null | undefined;
	actor?: Actor | "other";
	/** True only on a bot-authored PR. Enables the default-comment-event path. */
	allowDefault?: boolean;
}

/**
 * Resolve a comment body to a decision. The free-text grammar:
 *
 *   1. No `@emdashbot` mention -> noop.
 *   2. The mention text is EXACTLY a known verb -> deterministic command
 *      (explicit bare verbs always win, including destructive ones).
 *   3. Bare `@emdashbot ` mention with no body -> readonly status reply.
 *   4. On a bot PR with a `defaultCommentEvent` state (in_review), the whole
 *      mention text is that event's arg (free-text feedback -> `revise`).
 *   5. Else, hand off to the intent classifier, constrained to this state's
 *      non-destructive commands.
 *   6. Else (no eligible commands) -> noop.
 */
export function resolveComment({
	labels,
	body,
	actor,
	allowDefault,
}: ResolveCommentInput): CommentDecision {
	const text = parseMention(body);
	if (text === null) return { kind: "noop", reason: "no @emdashbot mention" };
	if (text === "") {
		const statusMeta = EVENTS.status;
		if (actor && statusMeta && (!isMachineActor(actor) || !statusMeta.actors.includes(actor))) {
			return { kind: "noop", reason: `actor "${actor}" may not request status` };
		}
		return { kind: "readonly", state: currentState(labels), event: "status" };
	}
	const cmd = parseCommand(body);
	if (cmd) return resolve({ labels, event: cmd.event, arg: cmd.arg, actor });
	const from = currentState(labels);
	if (allowDefault && from && STATES[from]?.defaultCommentEvent) {
		const def = STATES[from].defaultCommentEvent;
		if (def) return resolve({ labels, event: def, arg: text, actor });
	}
	const commands = classifierCommands(from);
	if (commands.length) return { kind: "classify", state: from, commands, text, actor };
	return { kind: "noop", reason: "no actionable command", from };
}

/** The self-documenting footer listing valid commands from a state. */
export function replyFooter(state: StateId | null): string {
	if (!state || !STATES[state]) return "";
	const cmds = STATES[state].offeredCommands
		.map((v) => `\`@emdashbot ${v.replace(UNDERSCORE_RE, " ")}\``)
		.join(" · ");
	return `\n\n---\n_State: \`${state}\`. Available: ${cmds}_`;
}

export interface AgentResult {
	skipped?: boolean;
	reproduced?: boolean;
	fixed?: boolean;
	verdict?: string;
	[key: string]: unknown;
}

export type InvestigationMode = "repro" | "implement" | "revise";

/**
 * Map the investigate agent's flat result to a machine event. Deterministic
 * glue between the agent's structured output and the state machine.
 *
 * - `ok` is false when the run errored or produced no parseable result.
 * - `pushed` is the trusted push step's report. A model claim of `fixed: true`
 *   is only "fix_ready" when a branch actually exists.
 */
export function outcomeFromResult({
	ok,
	result,
	pushed,
	mode,
}: {
	ok: boolean;
	result?: AgentResult | null;
	pushed?: boolean;
	mode?: InvestigationMode;
}): EventId {
	if (!ok || !result || typeof result !== "object") return "agent.failed";
	if (result.skipped === true) return "agent.skipped";
	if (result.verdict === "intended-behavior") return "agent.by_design";
	const effectiveMode = mode ?? "repro";
	if (effectiveMode === "repro" && result.reproduced !== true) return "agent.not_reproduced";
	if (result.fixed === true) return pushed === true ? "agent.fix_ready" : "agent.failed";
	return effectiveMode === "repro" ? "agent.reproduced" : "agent.failed";
}

/** Invariant check: exactly one kind + one state label. */
export function invariantProblems(labelNames: readonly string[]): string[] {
	const problems: string[] = [];
	const states = labelNames.filter((l) => STATE_LABEL_SET.has(l));
	const kinds = labelNames.filter((l) => KIND_LABEL_SET.has(l));
	if (states.length !== 1)
		problems.push(`expected exactly 1 state label, found ${states.length}: [${states.join(", ")}]`);
	if (kinds.length !== 1)
		problems.push(`expected exactly 1 kind label, found ${kinds.length}: [${kinds.join(", ")}]`);
	return problems;
}

export { STATE_LABELS, KIND_LABELS };
