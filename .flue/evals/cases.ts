// Shared eval dataset for the command classifier.
//
// Each case is a realistic (state, comment) pair with the expected machine
// event. Used by both `command-classifier.eval.ts` (the vitest gate) and
// `sweep.mjs` (the model comparison harness) so the two never drift.
//
// `tag` groups related phrasings so a failure cluster is visible at a glance
// (e.g. all the casual retry idioms, all the polite no-action questions).

import machine from "../../.github/bot/machine.json" with { type: "json" };

export interface Command {
	event: string;
	description: string;
	arg?: string | null;
}

export interface Case {
	state: string;
	comment: string;
	expected: string;
	tag: string;
	botContext?: string;
}

/** Mirror of router.classifierCommands, derived from the same spec. */
export function commandsFor(state: string): Command[] {
	const s = (machine.states as Record<string, { offeredCommands: string[] }>)[state];
	if (!s) throw new Error(`unknown state: ${state}`);
	const events = machine.events as Record<string, { description?: string; arg?: string | null; destructive?: boolean }>;
	return s.offeredCommands
		.filter((e) => !events[e]?.destructive)
		.map((e) => ({ event: e, description: events[e]?.description ?? "", arg: events[e]?.arg ?? null }));
}

// Tag taxonomy:
//   plain      direct, unambiguous wording of the action
//   idiomatic  realistic but informal / colloquial wording
//   directive  carries a concrete instruction the bot should pass through
//   polite-no  a polite refusal / "leave it" that must NOT trigger a destructive action
//   adjacent   destructive-intent prose that MUST stay `none` (bare verbs only)
//   mixed      partial agreement / hedged reply
//   question   a question that doesn't ask the bot to do anything
//   feedback   review-style code feedback on a bot PR
//
export const CASES: Case[] = [
	// --- triage: candidates [repro, implement, status, help] ---
	{ state: "triage", comment: "can you try to reproduce this?", expected: "repro", tag: "plain" },
	{ state: "triage", comment: "would you take a stab at reproducing this", expected: "repro", tag: "idiomatic" },
	{ state: "triage", comment: "please build a settings toggle for this", expected: "implement", tag: "plain" },
	{ state: "triage", comment: "let's add a way to customize the slug format", expected: "implement", tag: "idiomatic" },
	{ state: "triage", comment: "what do you think about this one?", expected: "none", tag: "question" },
	{ state: "triage", comment: "ping me when you have a moment to look", expected: "none", tag: "polite-no" },

	// --- blocked: candidates [implement, repro, retry, status, help] ---
	// Plain implement
	{ state: "blocked", comment: "yes, go with option A but namespace it as emdash-admin", expected: "implement", tag: "directive" },
	{ state: "blocked", comment: "implement that approach", expected: "implement", tag: "plain" },
	{ state: "blocked", comment: "do it, but use a LEFT JOIN instead of the subquery", expected: "implement", tag: "directive" },
	{ state: "blocked", comment: "ship the second option", expected: "implement", tag: "idiomatic" },
	{ state: "blocked", comment: "yeah let's just go with that", expected: "implement", tag: "idiomatic" },
	// Casual retry idioms (the cluster qwen3 missed on)
	{ state: "blocked", comment: "give it another go", expected: "retry", tag: "idiomatic" },
	{ state: "blocked", comment: "try again please", expected: "retry", tag: "idiomatic" },
	{ state: "blocked", comment: "have another crack at it", expected: "retry", tag: "idiomatic" },
	{ state: "blocked", comment: "one more shot", expected: "retry", tag: "idiomatic" },
	{ state: "blocked", comment: "rerun it", expected: "retry", tag: "idiomatic" },
	// Polite no-action / leave-it phrasings, must stay `none`
	{ state: "blocked", comment: "this is working as intended, close it", expected: "none", tag: "adjacent" },
	{ state: "blocked", comment: "nah, leave it for now", expected: "none", tag: "polite-no" },
	{ state: "blocked", comment: "actually this is by design", expected: "none", tag: "adjacent" },
	{ state: "blocked", comment: "I'll take this one over manually", expected: "none", tag: "adjacent" },
	{ state: "blocked", comment: "what part of the codebase is this in?", expected: "none", tag: "question" },
	{ state: "blocked", comment: "hmm not sure this is even a bug", expected: "none", tag: "adjacent" },

	// --- awaiting_feedback: candidates [confirm, reject, retry, status, help] ---
	// Plain confirms
	{ state: "awaiting_feedback", comment: "just tested the preview, the bug is gone, thanks!", expected: "confirm", tag: "plain" },
	{ state: "awaiting_feedback", comment: "lgtm", expected: "confirm", tag: "idiomatic" },
	{ state: "awaiting_feedback", comment: "works for me now", expected: "confirm", tag: "idiomatic" },
	{ state: "awaiting_feedback", comment: "all good, ship it", expected: "confirm", tag: "idiomatic" },
	{ state: "awaiting_feedback", comment: "that did the trick", expected: "confirm", tag: "idiomatic" },
	// Plain rejects
	{ state: "awaiting_feedback", comment: "nope, still broken on my end, same error", expected: "reject", tag: "plain" },
	{ state: "awaiting_feedback", comment: "no dice, same issue", expected: "reject", tag: "idiomatic" },
	{ state: "awaiting_feedback", comment: "didn't help, the page still 500s", expected: "reject", tag: "idiomatic" },
	// Mixed: partial fix is still a reject (the original bug isn't fully gone)
	{ state: "awaiting_feedback", comment: "fixed the error but now I see a different one when I save", expected: "reject", tag: "mixed" },
	// Questions / off-topic
	{ state: "awaiting_feedback", comment: "how do I install the preview?", expected: "none", tag: "question" },
	{ state: "awaiting_feedback", comment: "when will this land in a release?", expected: "none", tag: "question" },
	// Maintainer asks for a different approach instead of confirming
	{ state: "awaiting_feedback", comment: "can you take another approach, the current one breaks SSR", expected: "retry", tag: "directive" },

	// --- in_review: free-text on a bot PR routes to `revise` ---
	// Most of these will be handled by the deterministic default in resolveComment
	// (allowDefault=true on a bot PR), so the classifier rarely sees them; keep a
	// few here to verify it ALSO picks `revise` when invoked.
	{ state: "in_review", comment: "the test name is misleading, rename it and add a null check", expected: "revise", tag: "feedback" },
	{ state: "in_review", comment: "nit: could you rename `foo` to `fooSlug` for consistency", expected: "revise", tag: "feedback" },
	{ state: "in_review", comment: "please add a test for the empty-array case", expected: "revise", tag: "feedback" },
	{ state: "in_review", comment: "this needs to handle the locale=null path", expected: "revise", tag: "feedback" },

	// --- failed: candidates [retry, implement, repro, status, help] ---
	{ state: "failed", comment: "try that again please", expected: "retry", tag: "idiomatic" },
	{ state: "failed", comment: "the gateway was overloaded, run it again", expected: "retry", tag: "idiomatic" },
	{ state: "failed", comment: "implement it differently, use a LEFT JOIN this time", expected: "implement", tag: "directive" },
	{ state: "failed", comment: "let's try the alternative approach you mentioned", expected: "implement", tag: "directive" },
	{ state: "failed", comment: "what error did it hit?", expected: "none", tag: "question" },
];
