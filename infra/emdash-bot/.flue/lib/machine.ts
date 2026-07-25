// emdashbot orchestration state machine -- single source of truth.
//
// This file defines the *orchestration* layer only: the states a work item
// can be in, the events that move it between them, who may fire each event,
// and which agent action a transition kicks off. It deliberately says nothing
// about HOW the agent reproduces, diagnoses, or fixes -- that lives in
// `.flue/` and is invoked as an opaque "action" here.
//
// Everything else is generated from this file (run `pnpm bot:generate`):
//   - machine.json          runtime artifact loaded by the router workflows
//   - BOT_STATE_MACHINE.md   human docs: diagram + transition table + grammar
//
// CI re-runs the generator and fails if the committed artifacts drift, the
// same contract as the query-count snapshots. Edit this file, regenerate,
// commit all three.
//
// Design invariants (asserted by validateMachine):
//   1. Exactly one `kind` label and one `state` label per item.
//   2. Every non-terminal state has at least one outgoing transition.
//   3. No dead ends: every state can reach a terminal, and every terminal
//      has a `reopen` edge back into the live machine.
//   4. Every state is reachable from the `unmanaged` entry state. (`triage` is
//      the labeled landing state items return to after `reopen` / `hand_back`.)

// ---------------------------------------------------------------------------
// Kinds (category dimension -- mutually exclusive, mutable by command)
// ---------------------------------------------------------------------------

export const KINDS = ["bug", "enhancement", "task"] as const;
export type Kind = (typeof KINDS)[number];

// ---------------------------------------------------------------------------
// States (lifecycle dimension -- mutually exclusive)
// ---------------------------------------------------------------------------

export type StateId =
	| "unmanaged"
	| "triage"
	| "working"
	| "blocked"
	| "awaiting_feedback"
	| "in_review"
	| "human_owned"
	| "done"
	| "declined"
	| "failed";

export interface StateMeta {
	/** GitHub label that encodes this state. One per item, always. */
	label: string;
	/** Projects v2 "Triage State" board column. */
	boardColumn: string;
	/** Short description shown in docs and `@emdashbot status`. */
	description: string;
	/** Terminal states are reopenable but otherwise at rest. */
	terminal: boolean;
	/**
	 * Transient states mean an agent run is in flight; the control listener
	 * tells the maintainer "a run is in progress" rather than racing it.
	 */
	transient?: boolean;
	/** Commands offered in the bot's self-documenting comment footer. */
	offeredCommands: CommandVerb[];
	/**
	 * On a bot-authored PR, an `@emdashbot` comment whose verb isn't a known
	 * command is treated as this event, with the whole comment as its arg.
	 * Lets reviewers leave plain feedback ("@emdashbot the test name is wrong")
	 * without remembering the `revise` keyword. Explicit verbs still win, and
	 * the `@emdashbot` mention is still required so random PR chatter is inert.
	 */
	defaultCommentEvent?: CommandVerb;
}

export const STATES: Record<StateId, StateMeta> = {
	unmanaged: {
		// The implicit starting point: an issue the bot has never touched. It
		// carries no state label, so it is not provisioned and never appears on
		// the board until a command moves it in. Entry commands (repro /
		// implement / decline) work here directly -- triage is not a prerequisite.
		label: "",
		boardColumn: "(none)",
		description:
			"No bot labels yet. An issue nobody has handed to the bot. Entry commands work directly.",
		terminal: false,
		offeredCommands: ["repro", "implement", "decline"],
	},
	triage: {
		label: "bot:triage",
		boardColumn: "Triage",
		description: "Filed and awaiting a decision on whether/how the bot should act.",
		terminal: false,
		offeredCommands: ["repro", "implement", "decline"],
	},
	working: {
		label: "bot:working",
		boardColumn: "Working",
		description: "An agent run is in flight (reproduce / diagnose / verify / fix / implement).",
		terminal: false,
		transient: true,
		offeredCommands: ["status"],
	},
	blocked: {
		label: "bot:blocked",
		boardColumn: "Blocked",
		description:
			"The bot stopped and needs a human decision. Covers the old skipped / not-reproduced / reproduced-no-fix / by-design outcomes; the reason is in the bot's comment.",
		terminal: false,
		offeredCommands: ["implement", "repro", "retry", "decline", "take_over"],
	},
	awaiting_feedback: {
		label: "bot:awaiting-feedback",
		boardColumn: "Awaiting feedback",
		description:
			"A fix is staged on bot/fix-<n>; waiting for the reporter or a maintainer to confirm or reject.",
		terminal: false,
		offeredCommands: ["confirm", "reject", "retry", "take_over"],
	},
	in_review: {
		label: "bot:in-review",
		boardColumn: "In review",
		description:
			"A PR is open. The review/* sub-states live on the PR and roll up here. On a bot PR, a plain `@emdashbot` comment is feedback; explicit verbs still win.",
		terminal: false,
		offeredCommands: ["revise", "decline", "take_over"],
		defaultCommentEvent: "revise",
	},
	human_owned: {
		label: "bot:human-owned",
		boardColumn: "Human owned",
		description:
			"A maintainer took it over; the bot stays disengaged but the item stays on the board.",
		terminal: false,
		offeredCommands: ["hand_back"],
	},
	done: {
		label: "bot:done",
		boardColumn: "Done",
		description: "Shipped (PR merged) or confirmed resolved.",
		terminal: true,
		offeredCommands: ["reopen"],
	},
	declined: {
		label: "bot:declined",
		boardColumn: "Declined",
		description: "Won't be actioned (by design, out of scope, or a maintainer call).",
		terminal: true,
		offeredCommands: ["reopen"],
	},
	failed: {
		label: "bot:failed",
		boardColumn: "Failed",
		description: "An agent run errored or produced no usable result. Retryable -- not a dead end.",
		terminal: false,
		offeredCommands: ["retry", "implement", "repro", "decline"],
	},
};

// ---------------------------------------------------------------------------
// Actors (who is allowed to fire an event)
// ---------------------------------------------------------------------------

export type Actor =
	// The original issue reporter (confirm/reject their own report).
	| "reporter"
	// Any account with a live write/triage/maintain/admin role on the repo.
	| "maintainer"
	// Emitted by an agent action workflow reporting its own result. Not a human.
	| "system";

// ---------------------------------------------------------------------------
// Events (everything that can move an item)
// ---------------------------------------------------------------------------

// Maintainer/reporter-facing verbs, spoken as `@emdashbot <verb> [args]` or,
// for a few, applied as a label. Keep this list and the grammar in sync.
export type CommandVerb =
	| "repro"
	| "implement"
	| "retry"
	| "revise"
	| "confirm"
	| "reject"
	| "decline"
	| "reopen"
	| "take_over"
	| "hand_back"
	| "reset"
	| "status"
	| "help";

// Events the agent action workflow emits after a run, derived from the flat
// gating fields in the Flue result (skipped / reproduced / fixed / verdict).
// These names map 1:1 to the agent contract in .flue/workflows/investigate.ts.
export type AgentEvent =
	| "agent.skipped" // result.skipped === true
	| "agent.not_reproduced" // !skipped && !reproduced
	| "agent.by_design" // verdict === "intended-behavior"
	| "agent.reproduced" // reproduced && !fixed
	| "agent.fix_ready" // reproduced && fixed
	| "agent.failed"; // nonzero exit / no result file

// GitHub PR lifecycle events that propagate onto the anchoring issue.
export type PrEvent =
	| "pr.opened"
	| "pr.merged"
	| "pr.closed"
	| "pr.changes_requested"
	| "pr.approved";

export type EventId = CommandVerb | AgentEvent | PrEvent;

export interface EventMeta {
	description: string;
	actors: Actor[];
	/** Verb labels that fire this event in addition to the `@emdashbot` grammar. */
	labelTriggers?: string[];
	/** True for status/help: render the item's state, never mutate it. */
	readOnly?: boolean;
	/** Free-text argument the verb carries (a directive, feedback, etc.). */
	arg?: "directive" | "feedback";
	/**
	 * Hard-to-undo actions. In free-text mode these are NOT offered to the
	 * intent classifier -- they fire only via an exact bare `@emdashbot <verb>`,
	 * so a misread sentence can never silently close or disengage an item.
	 */
	destructive?: boolean;
	/**
	 * For entry events (transitions from `unmanaged`), the default kind to
	 * assign alongside the state label so the one-kind-one-state invariant
	 * holds on first contact. Maintainers can override later by relabeling.
	 */
	defaultKind?: Kind;
}

export const EVENTS: Record<EventId, EventMeta> = {
	// --- commands ---
	repro: {
		description: "Reproduce the issue as a bug and attempt a fix.",
		actors: ["maintainer"],
		labelTriggers: ["bot:repro"],
		defaultKind: "bug",
	},
	implement: {
		description:
			"Build the described change (feature or directed fix), skipping the bug-repro gate.",
		actors: ["maintainer"],
		labelTriggers: ["bot:implement"],
		arg: "directive",
		defaultKind: "enhancement",
	},
	// NB: `retry` is always wired to `investigate.repro` in the transition
	// table (we don't persist the previous run's mode), so the user-facing
	// description has to say what it actually does. After `implement`/`revise`,
	// re-issue the original command verb instead.
	retry: { description: "Re-run the bug reproduction pipeline.", actors: ["maintainer"] },
	revise: {
		description: "Send review feedback back into the agent to update the open PR branch.",
		actors: ["maintainer"],
		arg: "feedback",
	},
	confirm: {
		description: "Confirm the staged fix works; open a PR.",
		actors: ["reporter", "maintainer"],
	},
	reject: {
		description: "The staged fix does not work; retry with feedback.",
		actors: ["reporter", "maintainer"],
		// The free-text body of the reject reply IS the feedback the revise
		// agent needs. Mark this so the classifier extracts the whole comment
		// into `arg`, which then becomes the dispatched run's retryContext.
		arg: "feedback",
	},
	decline: {
		description: "Won't be actioned; move to declined.",
		actors: ["maintainer"],
		destructive: true,
		// `decline` is also a valid entry transition from unmanaged. The kind
		// here is a placeholder (the item is terminal); `task` is the neutral
		// option that isn't `bug` or `enhancement`.
		defaultKind: "task",
	},
	reopen: { description: "Bring a terminal item back into triage.", actors: ["maintainer"] },
	take_over: {
		description: "A maintainer takes the item; the bot disengages but stays on the board.",
		actors: ["maintainer"],
		destructive: true,
	},
	hand_back: { description: "Return a human-owned item to the bot.", actors: ["maintainer"] },
	// Maintainer recovery for a half-applied label swap (multiple state labels
	// on one issue). Strips every state label and lands on triage. Destructive
	// only to bot:* state metadata, not to issue content; gated to bare-verb-
	// only so a misread sentence can't accidentally reset state.
	reset: {
		description: "Force-reset to triage. Maintainer recovery for conflicting state labels.",
		actors: ["maintainer"],
		destructive: true,
	},
	status: {
		description: "Render the item's current state and available commands.",
		actors: ["reporter", "maintainer"],
		readOnly: true,
	},
	help: {
		description: "Show the command grammar.",
		actors: ["reporter", "maintainer"],
		readOnly: true,
	},
	// --- agent results ---
	"agent.skipped": {
		description: "Agent skipped (non-bug kind, or repro needs external/prod-only conditions).",
		actors: ["system"],
	},
	"agent.not_reproduced": {
		description: "Agent could not reproduce the issue.",
		actors: ["system"],
	},
	"agent.by_design": {
		description: "Agent verified the behaviour as intended.",
		actors: ["system"],
	},
	"agent.reproduced": {
		description: "Reproduced, but the fix needs a human decision.",
		actors: ["system"],
	},
	"agent.fix_ready": {
		description: "Reproduced and fixed; a verified change is staged on bot/fix-<n>.",
		actors: ["system"],
	},
	"agent.failed": {
		description: "Agent run errored or produced no usable result.",
		actors: ["system"],
	},
	// --- PR lifecycle ---
	"pr.opened": { description: "A bot PR was opened for this item.", actors: ["system"] },
	"pr.merged": { description: "The bot PR was merged.", actors: ["system"] },
	"pr.closed": {
		description: "The bot PR was closed without merging.",
		actors: ["system"],
	},
	"pr.changes_requested": {
		description: "A reviewer requested changes (review sub-state).",
		actors: ["system"],
	},
	"pr.approved": {
		description: "A reviewer approved the PR (review sub-state).",
		actors: ["system"],
	},
};

// ---------------------------------------------------------------------------
// Actions (opaque agent runs a transition can kick off)
// ---------------------------------------------------------------------------

// The router dispatches these; the implementing workflow is the EXISTING
// agent (investigate.yml) whose internals we do not touch. `mode` selects the
// entry behaviour the agent already supports.
export type ActionId =
	| "investigate.repro" // bug repro -> diagnose -> verify -> fix
	| "investigate.implement" // directed build/fix (sets maintainerDirective)
	| "investigate.revise" // re-run against existing bot/fix-<n> with PR feedback
	| "openPr" // push branch (already done) + gh pr create
	| "closePr"; // close the bot PR

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export interface Transition {
	from: StateId;
	event: EventId;
	to: StateId;
	/** Agent action the router dispatches on this transition, if any. */
	action?: ActionId;
	/** Human-readable note for the generated table. */
	note?: string;
}

export const TRANSITIONS: Transition[] = [
	// --- entry on an untriaged issue (no triage step required) ---
	{ from: "unmanaged", event: "repro", to: "working", action: "investigate.repro" },
	{
		from: "unmanaged",
		event: "implement",
		to: "working",
		action: "investigate.implement",
		note: "implement works straight from an untriaged issue",
	},
	{ from: "unmanaged", event: "decline", to: "declined" },

	// --- entry from triage (the labeled resting state after reopen/hand_back) ---
	{ from: "triage", event: "repro", to: "working", action: "investigate.repro" },
	{
		from: "triage",
		event: "implement",
		to: "working",
		action: "investigate.implement",
		note: "enhancement/feature lane -- no repro gate",
	},
	{ from: "triage", event: "decline", to: "declined" },

	// --- agent run outcomes (from working) ---
	{ from: "working", event: "agent.skipped", to: "blocked", note: "reason: skipped (was a sink)" },
	{
		from: "working",
		event: "agent.not_reproduced",
		to: "blocked",
		note: "reason: not-reproduced (was a sink)",
	},
	{ from: "working", event: "agent.by_design", to: "blocked", note: "reason: by-design" },
	{
		from: "working",
		event: "agent.reproduced",
		to: "blocked",
		note: "reason: fix needs a decision",
	},
	{
		from: "working",
		event: "agent.fix_ready",
		to: "awaiting_feedback",
		note: "executor pushes bot/fix-<n>; orchestrator asks the reporter to confirm. PR opens on confirm, not here.",
	},
	{ from: "working", event: "agent.failed", to: "failed" },

	// --- blocked: every reason accepts the same overrides (kills the sinks) ---
	{ from: "blocked", event: "implement", to: "working", action: "investigate.implement" },
	{ from: "blocked", event: "repro", to: "working", action: "investigate.repro" },
	{ from: "blocked", event: "retry", to: "working", action: "investigate.repro" },
	{ from: "blocked", event: "decline", to: "declined" },
	{ from: "blocked", event: "take_over", to: "human_owned" },

	// --- awaiting feedback ---
	{ from: "awaiting_feedback", event: "confirm", to: "in_review", action: "openPr" },
	{
		from: "awaiting_feedback",
		event: "reject",
		to: "working",
		action: "investigate.revise",
		note: "retry with reporter feedback",
	},
	{ from: "awaiting_feedback", event: "retry", to: "working", action: "investigate.repro" },
	{ from: "awaiting_feedback", event: "take_over", to: "human_owned" },

	// --- in review (the PR bridge) ---
	{
		from: "in_review",
		event: "pr.opened",
		to: "in_review",
		note: "idempotent; sets review sub-state",
	},
	{ from: "in_review", event: "pr.approved", to: "in_review", note: "review sub-state only" },
	{
		from: "in_review",
		event: "pr.changes_requested",
		to: "in_review",
		note: "review sub-state only",
	},
	{
		from: "in_review",
		event: "revise",
		to: "working",
		action: "investigate.revise",
		note: "PR feedback -> agent (was impossible)",
	},
	{ from: "in_review", event: "pr.merged", to: "done" },
	// A bot PR can be merged from non-review states too. Keep pr.merged terminal
	// from every state where the PR may still be open: bot:working (during a
	// revise run) and bot:awaiting-feedback (right after a revise produced a
	// new fix and is awaiting reporter confirmation). Late agent results that
	// arrive after the merge no-op via investigate-run.yml's terminal guard.
	{ from: "working", event: "pr.merged", to: "done", note: "merged mid-revise" },
	{ from: "awaiting_feedback", event: "pr.merged", to: "done", note: "merged before confirm" },

	// Closed without merge is not done. Return to blocked so a human can
	// re-open the PR path, re-run, or take over. Mirror pr.merged's coverage
	// of states where a bot PR may still be open.
	{ from: "in_review", event: "pr.closed", to: "blocked", note: "PR closed without merge" },
	{ from: "working", event: "pr.closed", to: "blocked", note: "PR closed mid-revise" },
	{
		from: "awaiting_feedback",
		event: "pr.closed",
		to: "blocked",
		note: "PR closed while awaiting confirm",
	},

	// reset: maintainer recovery from every state, including conflicting/null.
	// resolve() has a special path for `reset` that ignores currentState.
	{ from: "unmanaged", event: "reset", to: "triage" },
	{ from: "triage", event: "reset", to: "triage" },
	{ from: "working", event: "reset", to: "triage" },
	{ from: "blocked", event: "reset", to: "triage" },
	{ from: "awaiting_feedback", event: "reset", to: "triage" },
	{ from: "in_review", event: "reset", to: "triage" },
	{ from: "human_owned", event: "reset", to: "triage" },
	{ from: "done", event: "reset", to: "triage" },
	{ from: "declined", event: "reset", to: "triage" },
	{ from: "failed", event: "reset", to: "triage" },
	{ from: "in_review", event: "decline", to: "declined", action: "closePr" },
	{ from: "in_review", event: "take_over", to: "human_owned" },

	// --- human owned ---
	{ from: "human_owned", event: "hand_back", to: "triage" },

	// --- terminals: reopenable, never dead ---
	{ from: "done", event: "reopen", to: "triage" },
	{ from: "declined", event: "reopen", to: "triage" },

	// --- failed: retryable ---
	{ from: "failed", event: "retry", to: "working", action: "investigate.repro" },
	{ from: "failed", event: "implement", to: "working", action: "investigate.implement" },
	{ from: "failed", event: "repro", to: "working", action: "investigate.repro" },
	{ from: "failed", event: "decline", to: "declined" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const ENTRY_STATE: StateId = "unmanaged";

/**
 * Provisionable state labels. `unmanaged` is the implicit no-label start, so it
 * is excluded -- it is never written, only inferred from the absence of a state
 * label. This is also the set the "exactly one state" invariant checks against.
 */
export function stateLabels(): string[] {
	return Object.values(STATES)
		.map((s) => s.label)
		.filter((l) => l !== "");
}

/** All kind labels. */
export function kindLabels(): string[] {
	return KINDS.map((k) => `bot:${k}`);
}

/** Look up the single transition for (state, event), or undefined. */
export function findTransition(from: StateId, event: EventId): Transition | undefined {
	return TRANSITIONS.find((t) => t.from === from && t.event === event);
}

/** Events that are valid commands from a given state (for status/help replies). */
export function commandsFrom(from: StateId): CommandVerb[] {
	return STATES[from].offeredCommands;
}

export interface MachineProblem {
	severity: "error";
	message: string;
}

/**
 * Structural validation. Run by the generator and in CI so a malformed edit
 * to this file fails fast rather than shipping a broken machine.
 */
export function validateMachine(): MachineProblem[] {
	const problems: MachineProblem[] = [];
	// `STATES` is declared `Record<StateId, ...>`, so the narrowing is safe.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	const stateIds = Object.keys(STATES) as StateId[];

	// Determinism: at most one transition per (state, event).
	const seen = new Set<string>();
	for (const t of TRANSITIONS) {
		const key = `${t.from}::${t.event}`;
		if (seen.has(key))
			problems.push({
				severity: "error",
				message: `Non-deterministic: two transitions for ${key}`,
			});
		seen.add(key);
		if (!STATES[t.to])
			problems.push({
				severity: "error",
				message: `Transition ${key} targets unknown state ${t.to}`,
			});
	}

	// Unique labels across kinds + states.
	const labels = [...kindLabels(), ...stateLabels()];
	if (new Set(labels).size !== labels.length)
		problems.push({ severity: "error", message: "Duplicate label across kinds/states" });

	// Every non-terminal state has an outgoing edge.
	for (const id of stateIds) {
		const out = TRANSITIONS.filter((t) => t.from === id);
		if (!STATES[id].terminal && out.length === 0)
			problems.push({
				severity: "error",
				message: `Non-terminal state "${id}" has no outgoing transition (dead end)`,
			});
	}

	// Every terminal state has a reopen edge.
	for (const id of stateIds) {
		if (STATES[id].terminal && !findTransition(id, "reopen"))
			problems.push({ severity: "error", message: `Terminal state "${id}" has no reopen edge` });
	}

	// Reachability from the entry state.
	const reachable = new Set<StateId>([ENTRY_STATE]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const t of TRANSITIONS) {
			if (reachable.has(t.from) && !reachable.has(t.to)) {
				reachable.add(t.to);
				grew = true;
			}
		}
	}
	for (const id of stateIds) {
		if (!reachable.has(id))
			problems.push({
				severity: "error",
				message: `State "${id}" is unreachable from "${ENTRY_STATE}"`,
			});
	}

	// Every state can reach a terminal (no trap components).
	for (const id of stateIds) {
		if (!canReachTerminal(id))
			problems.push({
				severity: "error",
				message: `State "${id}" cannot reach any terminal state`,
			});
	}

	return problems;
}

function canReachTerminal(start: StateId): boolean {
	const stack = [start];
	const seen = new Set<StateId>();
	while (stack.length) {
		// `stack` only ever holds StateIds (pushed from typed sources above).
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		const id = stack.pop() as StateId;
		if (seen.has(id)) continue;
		seen.add(id);
		if (STATES[id].terminal) return true;
		for (const next of TRANSITIONS.filter((t) => t.from === id)) stack.push(next.to);
	}
	return false;
}

/** The full machine as a plain object, for serialization to machine.json. */
export function machineSnapshot() {
	return {
		kinds: KINDS,
		entryState: ENTRY_STATE,
		states: STATES,
		events: EVENTS,
		transitions: TRANSITIONS,
	};
}
