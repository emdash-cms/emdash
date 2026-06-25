// Pure router logic for the emdashbot state machine.
//
// This module contains NO GitHub API calls and NO side effects. It maps
// (current labels, incoming event) to a decision the calling workflow then
// executes (swap labels, dispatch an agent action, post a reply). Keeping it
// pure makes it unit-testable with `node --test` and reusable across the
// thin event workflows (control listener, system-event handler, linter).
//
// Loaded by actions/github-script via require("./.github/bot/router.cjs").
// Reads the generated machine.json so the spec stays the single source of truth.

const machine = require("./machine.json");

const KIND_LABELS = machine.kinds.map((k) => `bot:${k}`);
const KIND_LABEL_SET = new Set(KIND_LABELS);
const STATE_LABEL_TO_ID = Object.fromEntries(
	Object.entries(machine.states).map(([id, meta]) => [meta.label, id]),
);
const STATE_LABELS = Object.values(machine.states).map((s) => s.label);
const STATE_LABEL_SET = new Set(STATE_LABELS);

// Regex literals hoisted to module scope so oxlint doesn't flag re-compilation.
//
// MENTION_RE matches an `@emdashbot` mention at the START of any line and
// captures EVERYTHING that follows it through end-of-input (across newlines).
//
// The `m` flag is on `^` only -- we want the mention to start a line so prose
// containing `@emdashbot` in the middle of a sentence doesn't fire. The
// CAPTURE group then greedily eats `[\s\S]*` (any char including newline) to
// the end of the input, NOT to the end of the line. This is load-bearing for
// `parseCommand`'s strict bare-verb check: a comment like
// `@emdashbot decline\nplease don't` would otherwise be treated as a bare
// `decline` (an `$` end-of-line anchor with the `m` flag matches after the
// verb word), bypassing the destructive-event guard. Now the capture is
// `"decline\nplease don't"`, which is not an exact verb, so the classifier
// sees the whole sentence and returns `none` for a destructive-adjacent intent.
const MENTION_RE = /^[ \t]*@emdashbot[ \t]+([\s\S]*)/m;
const WS_RE = /\s+/g;
const UNDERSCORE_RE = /_/g;

/**
 * The state id encoded in a label set.
 *   - 0 state labels -> "unmanaged" (the implicit start; commands still work)
 *   - 1 state label  -> that state
 *   - >1             -> null (invalid; the linter will flag it)
 */
function currentState(labelNames) {
	const found = labelNames.filter((l) => STATE_LABEL_SET.has(l)).map((l) => STATE_LABEL_TO_ID[l]);
	if (found.length === 0) return "unmanaged";
	return found.length === 1 ? found[0] : null;
}

/** The single kind ("bug"/...) encoded in a label set, or null. */
function currentKind(labelNames) {
	const found = labelNames.filter((l) => KIND_LABEL_SET.has(l)).map((l) => l.slice("bot:".length));
	return found.length === 1 ? found[0] : null;
}

/**
 * Parse an `@emdashbot <verb> [arg]` command from a comment body. Only a
 * directive at the START of a line counts, so a quoted command doesn't fire.
 * Returns { event, arg } or null. Multi-word verbs ("take over", "hand back")
 * are normalized to their event ids ("take_over", "hand_back").
 */
const VERB_ALIASES = {
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
 * mention. This is the gate: no mention means the bot never acts, even on a
 * bot PR.
 */
function parseMention(body) {
	if (!body) return null;
	const m = body.match(MENTION_RE);
	return m ? m[1].trim() : null;
}

/**
 * Parse a deterministic bare-verb command. The mention text must be EXACTLY a
 * known verb (after alias + whitespace normalization), e.g. `@emdashbot retry`
 * or `@emdashbot take over`. Any extra word makes it not a command -> null, so
 * the caller hands it to the intent classifier. This is the "harder to trigger
 * by accident" rule: arg-carrying intents (`implement <directive>`,
 * `revise <feedback>`) and any natural-language phrasing always route to the
 * classifier; only the exact verb fires deterministically.
 */
function parseCommand(body) {
	const text = parseMention(body);
	if (text === null) return null;
	const normalized = text.trim().toLowerCase().replace(WS_RE, " ");
	const event = VERB_ALIASES[normalized] || (isKnownEvent(normalized) ? normalized : null);
	if (!event) return null;
	return { event, arg: null };
}

/** True for hard-to-undo events excluded from free-text classification. */
function isDestructive(event) {
	return Boolean(machine.events[event] && machine.events[event].destructive);
}

/**
 * The commands the intent classifier may choose from in a given state: the
 * state's offered commands minus destructive ones (which require an exact bare
 * verb). Each carries its description and whether it takes a free-text arg, for
 * the classifier prompt.
 */
function classifierCommands(state) {
	if (!state || !machine.states[state]) return [];
	return machine.states[state].offeredCommands
		.filter((e) => !isDestructive(e))
		.map((e) => ({
			event: e,
			description: (machine.events[e] && machine.events[e].description) || "",
			arg: (machine.events[e] && machine.events[e].arg) || null,
		}));
}

function isKnownEvent(event) {
	return Object.hasOwn(machine.events, event);
}

/** Find the single transition for (state, event), or null. */
function findTransition(state, event) {
	return machine.transitions.find((t) => t.from === state && t.event === event) || null;
}

/**
 * Resolve an event against the current label set. Returns one of:
 *   { kind: "noop", reason }                     -- nothing to do; reply only
 *   { kind: "readonly", state }                  -- status/help; render only
 *   { kind: "transition", from, to, action,
 *     addLabels, removeLabels, event, arg }       -- execute this
 *
 * `addLabels` is an array (not the singular `addLabel`) so an entry transition
 * from `unmanaged` can attach both the state and the default kind in one
 * decision, satisfying the one-kind-one-state invariant on first contact.
 *
 * Authorization (actor role) is checked by the workflow, not here, but the
 * allowed actors for the event are surfaced so the caller can gate.
 */
function resolve({ labels, event, arg, actor }) {
	const from = currentState(labels);
	const meta = machine.events[event];
	if (!meta) return { kind: "noop", reason: `unknown event "${event}"` };
	// Actor check FIRST -- including for readonly events. Otherwise a drive-by
	// `@emdashbot status` from any GitHub user on a public issue would make the
	// bot post status replies it shouldn't, contradicting the actor list.
	if (actor && !meta.actors.includes(actor)) {
		return { kind: "noop", reason: `actor "${actor}" may not fire "${event}"` };
	}
	if (meta.readOnly) return { kind: "readonly", state: from, event };
	if (!from) return { kind: "noop", reason: "item has conflicting state labels" };
	const t = findTransition(from, event);
	if (!t) return { kind: "noop", reason: `no transition for ${from} + ${event}`, from };
	const toLabel = machine.states[t.to].label;
	const removeLabels = STATE_LABELS.filter((l) => l !== toLabel);

	// Entry from unmanaged: ensure a kind label is set so the linter invariant
	// (exactly one kind + one state) holds. If the issue carries no kind, apply
	// the event's defaultKind. If it carries a DIFFERENT kind than the verb
	// implies (e.g. `bot:enhancement` + `repro`, which means "treat as a bug"),
	// the verb wins: drop the mismatched kind and apply the verb's default.
	const addLabels = [toLabel];
	if (from === "unmanaged" && meta.defaultKind) {
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
		action: t.action || null,
		// `addLabel` (singular) kept for backwards compatibility with existing
		// callers; new code should use `addLabels` (plural).
		addLabel: toLabel,
		addLabels,
		removeLabels,
		event,
		arg: arg || null,
	};
}

/**
 * Resolve a comment body to a decision. The free-text grammar:
 *
 *   1. No `@emdashbot` mention -> noop. The mention is always required.
 *   2. The mention text is EXACTLY a known verb -> that command, deterministic
 *      (explicit bare verbs always win, including destructive ones).
 *   3. Else, on a bot PR with a `defaultCommentEvent` state (in_review), the
 *      whole text is that event's arg (free-text feedback -> `revise`) without a
 *      model call.
 *   4. Else, hand off to the intent classifier, constrained to this state's
 *      non-destructive commands: `{ kind: "classify", state, commands, text }`.
 *      The caller runs the classifier, then calls `resolve(state, event, arg)`.
 *   5. Else (no eligible commands) -> noop.
 *
 * `allowDefault` is the caller's "this is a bot-authored PR" signal.
 */
function resolveComment({ labels, body, actor, allowDefault }) {
	const text = parseMention(body);
	if (text === null) return { kind: "noop", reason: "no @emdashbot mention" };
	// Bare `@emdashbot` mention with no body: don't route to the classifier (it
	// fails the minLength(1) schema and silently returns `none`). Render the
	// item's state instead so the caller can post a help reply. Gated on actor
	// so a drive-by from a random user doesn't make the bot reply.
	if (text === "") {
		const statusMeta = machine.events.status;
		if (actor && statusMeta && !statusMeta.actors.includes(actor)) {
			return { kind: "noop", reason: `actor "${actor}" may not request status` };
		}
		return { kind: "readonly", state: currentState(labels), event: "status" };
	}
	const cmd = parseCommand(body);
	if (cmd) return resolve({ labels, event: cmd.event, arg: cmd.arg, actor });
	const from = currentState(labels);
	if (allowDefault && from && machine.states[from] && machine.states[from].defaultCommentEvent) {
		return resolve({ labels, event: machine.states[from].defaultCommentEvent, arg: text, actor });
	}
	const commands = classifierCommands(from);
	if (commands.length) return { kind: "classify", state: from, commands, text, actor };
	return { kind: "noop", reason: "no actionable command", from };
}

/** The self-documenting footer listing valid commands from a state. */
function replyFooter(state) {
	if (!state || !machine.states[state]) return "";
	const cmds = machine.states[state].offeredCommands
		.map((v) => `\`@emdashbot ${v.replace(UNDERSCORE_RE, " ")}\``)
		.join(" · ");
	return `\n\n---\n_State: \`${state}\`. Available: ${cmds}_`;
}

/**
 * Map the investigate agent's flat result to a machine event. This is the
 * deterministic glue the executor (investigate-run.yml) uses after `flue run`:
 * it reads the result JSON, calls this to get the `agent.*` event, then runs
 * `resolve` to apply the transition. Mirrors the flat gating fields produced by
 * .flue/workflows/investigate.ts (skipped / reproduced / fixed / verdict).
 *
 * - `ok` is false when the run errored or produced no parseable result, which
 *   is always `agent.failed` regardless of the (absent) fields.
 * - `pushed` is the trusted YAML push step's report. The model's `fixed: true`
 *   is only "fix_ready" when the orchestrator actually has a branch to ask the
 *   reporter about. If the agent claimed `fixed` but the push step set
 *   `pushed: false` (no diff staged, push rejected, or the branch carried
 *   non-bot human commits we refused to clobber), demote to `agent.failed` so
 *   the issue lands in the retryable failed state, not awaiting_feedback for a
 *   branch that doesn't exist.
 */
function outcomeFromResult({ ok, result, pushed }) {
	if (!ok || !result || typeof result !== "object") return "agent.failed";
	if (result.skipped === true) return "agent.skipped";
	if (result.verdict === "intended-behavior") return "agent.by_design";
	if (result.reproduced !== true) return "agent.not_reproduced";
	if (result.fixed === true) return pushed === true ? "agent.fix_ready" : "agent.failed";
	return "agent.reproduced";
}

/** Invariant check for the linter: exactly one kind + one state. */
function invariantProblems(labelNames) {
	const problems = [];
	const states = labelNames.filter((l) => STATE_LABEL_SET.has(l));
	const kinds = labelNames.filter((l) => KIND_LABEL_SET.has(l));
	if (states.length !== 1)
		problems.push(`expected exactly 1 state label, found ${states.length}: [${states.join(", ")}]`);
	if (kinds.length !== 1)
		problems.push(`expected exactly 1 kind label, found ${kinds.length}: [${kinds.join(", ")}]`);
	return problems;
}

module.exports = {
	machine,
	currentState,
	currentKind,
	parseMention,
	parseCommand,
	isDestructive,
	classifierCommands,
	findTransition,
	resolve,
	resolveComment,
	outcomeFromResult,
	replyFooter,
	invariantProblems,
	STATE_LABELS,
	KIND_LABELS,
};
