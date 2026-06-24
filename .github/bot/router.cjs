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
const STATE_LABEL_TO_ID = Object.fromEntries(
	Object.entries(machine.states).map(([id, meta]) => [meta.label, id]),
);
const STATE_LABELS = Object.values(machine.states).map((s) => s.label);

/**
 * The state id encoded in a label set.
 *   - 0 state labels -> "unmanaged" (the implicit start; commands still work)
 *   - 1 state label  -> that state
 *   - >1             -> null (invalid; the linter will flag it)
 */
function currentState(labelNames) {
	const found = labelNames.filter((l) => STATE_LABELS.includes(l)).map((l) => STATE_LABEL_TO_ID[l]);
	if (found.length === 0) return "unmanaged";
	return found.length === 1 ? found[0] : null;
}

/** The single kind ("bug"/...) encoded in a label set, or null. */
function currentKind(labelNames) {
	const found = labelNames.filter((l) => KIND_LABELS.includes(l)).map((l) => l.slice("bot:".length));
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
	const m = body.match(/^[ \t]*@emdashbot[ \t]+([\s\S]+?)[ \t]*$/im);
	return m ? m[1].trim() : null;
}

/**
 * Parse an `@emdashbot <verb> [arg]` command. Returns { event, arg } when the
 * verb is recognized, or null when there is no mention OR the verb is unknown
 * (an unknown verb may still become a default-event arg -- see resolveComment).
 */
function parseCommand(body) {
	const text = parseMention(body);
	if (text === null) return null;
	// Up to two leading words may form the verb ("take over"); the rest is arg.
	const m = text.match(/^([a-z]+(?:[ \t]+[a-z]+)?)([\s\S]*)$/i);
	if (!m) return null;
	let verb = m[1].trim().toLowerCase().replace(/\s+/g, " ");
	let rest = m[2] ? m[2].trim() : "";
	if (VERB_ALIASES[verb]) verb = VERB_ALIASES[verb];
	else {
		const oneWord = verb.split(" ")[0];
		if (VERB_ALIASES[oneWord]) {
			verb = VERB_ALIASES[oneWord];
		} else if (!isKnownEvent(verb)) {
			// Two-word parse failed to match; the second word is probably the arg.
			rest = (verb.split(" ").slice(1).join(" ") + " " + rest).trim();
			verb = oneWord;
		}
	}
	if (!isKnownEvent(verb)) return null;
	return { event: verb, arg: rest || null };
}

function isKnownEvent(event) {
	return Object.prototype.hasOwnProperty.call(machine.events, event);
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
 *     addLabel, removeLabels, event, arg }        -- execute this
 * Authorization (actor role) is checked by the workflow, not here, but the
 * allowed actors for the event are surfaced so the caller can gate.
 */
function resolve({ labels, event, arg, actor }) {
	const from = currentState(labels);
	const meta = machine.events[event];
	if (!meta) return { kind: "noop", reason: `unknown event "${event}"` };
	if (meta.readOnly) return { kind: "readonly", state: from, event };
	if (!from) return { kind: "noop", reason: "item has conflicting state labels" };
	if (actor && !meta.actors.includes(actor)) {
		return { kind: "noop", reason: `actor "${actor}" may not fire "${event}"` };
	}
	const t = findTransition(from, event);
	if (!t) return { kind: "noop", reason: `no transition for ${from} + ${event}`, from };
	const toLabel = machine.states[t.to].label;
	const removeLabels = STATE_LABELS.filter((l) => l !== toLabel);
	return {
		kind: "transition",
		from,
		to: t.to,
		action: t.action || null,
		addLabel: toLabel,
		removeLabels,
		event,
		arg: arg || null,
	};
}

/**
 * Resolve a comment body to a decision. This is the entry point the comment
 * listener uses, layering the implicit-feedback rule over the explicit grammar:
 *
 *   1. No `@emdashbot` mention -> noop. The mention is always required.
 *   2. A recognized verb -> that command (explicit verbs always win).
 *   3. Otherwise, if `allowDefault` (caller passes true only on a bot PR) and
 *      the current state defines `defaultCommentEvent`, the whole mention text
 *      becomes that event's argument (e.g. plain feedback -> `revise`).
 *   4. Else noop with a help reason.
 *
 * `allowDefault` is the caller's "this is a bot-authored PR" signal; the event
 * itself comes from the state's `defaultCommentEvent` in machine.json.
 */
function resolveComment({ labels, body, actor, allowDefault }) {
	const text = parseMention(body);
	if (text === null) return { kind: "noop", reason: "no @emdashbot mention" };
	const cmd = parseCommand(body);
	if (cmd) return resolve({ labels, event: cmd.event, arg: cmd.arg, actor });
	if (allowDefault) {
		const from = currentState(labels);
		const def = from && machine.states[from] ? machine.states[from].defaultCommentEvent : null;
		if (def) return resolve({ labels, event: def, arg: text, actor });
	}
	return { kind: "noop", reason: "unknown command", from: currentState(labels) };
}

/** The self-documenting footer listing valid commands from a state. */
function replyFooter(state) {
	if (!state || !machine.states[state]) return "";
	const cmds = machine.states[state].offeredCommands
		.map((v) => `\`@emdashbot ${v.replace(/_/g, " ")}\``)
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
 * `ok` is false when the run errored or produced no parseable result, which is
 * always `agent.failed` regardless of the (absent) fields.
 */
function outcomeFromResult({ ok, result }) {
	if (!ok || !result || typeof result !== "object") return "agent.failed";
	if (result.skipped === true) return "agent.skipped";
	if (result.verdict === "intended-behavior") return "agent.by_design";
	if (result.reproduced !== true) return "agent.not_reproduced";
	if (result.fixed === true) return "agent.fix_ready";
	return "agent.reproduced";
}

/** Invariant check for the linter: exactly one kind + one state. */
function invariantProblems(labelNames) {
	const problems = [];
	const states = labelNames.filter((l) => STATE_LABELS.includes(l));
	const kinds = labelNames.filter((l) => KIND_LABELS.includes(l));
	if (states.length !== 1) problems.push(`expected exactly 1 state label, found ${states.length}: [${states.join(", ")}]`);
	if (kinds.length !== 1) problems.push(`expected exactly 1 kind label, found ${kinds.length}: [${kinds.join(", ")}]`);
	return problems;
}

module.exports = {
	machine,
	currentState,
	currentKind,
	parseMention,
	parseCommand,
	findTransition,
	resolve,
	resolveComment,
	outcomeFromResult,
	replyFooter,
	invariantProblems,
	STATE_LABELS,
	KIND_LABELS,
};
