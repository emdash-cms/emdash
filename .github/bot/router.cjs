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

/** The single state id encoded in a label set, or null if 0 or >1. */
function currentState(labelNames) {
	const found = labelNames.filter((l) => STATE_LABELS.includes(l)).map((l) => STATE_LABEL_TO_ID[l]);
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

function parseCommand(body) {
	if (!body) return null;
	const m = body.match(/^[ \t]*@emdashbot[ \t]+([a-z]+(?:[ \t]+[a-z]+)?)([\s\S]*)$/im);
	if (!m) return null;
	let verb = m[1].trim().toLowerCase().replace(/\s+/g, " ");
	let rest = m[2] ? m[2].trim() : "";
	// Try the two-word form first, then collapse to one word.
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
	if (!from) return { kind: "noop", reason: "item has no single state label" };
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

/** The self-documenting footer listing valid commands from a state. */
function replyFooter(state) {
	if (!state || !machine.states[state]) return "";
	const cmds = machine.states[state].offeredCommands
		.map((v) => `\`@emdashbot ${v.replace(/_/g, " ")}\``)
		.join(" · ");
	return `\n\n---\n_State: \`${state}\`. Available: ${cmds}_`;
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
	parseCommand,
	findTransition,
	resolve,
	replyFooter,
	invariantProblems,
	STATE_LABELS,
	KIND_LABELS,
};
