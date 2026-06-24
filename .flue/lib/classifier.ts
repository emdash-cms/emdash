// Lightweight classifier shared between investigate and classify-reply
// workflows. Uses kimi-k2.6 via our Cloudflare AI Gateway -- cheap and
// fast for structured classification tasks.

import { writeFileSync } from "node:fs";

import { defineAgent } from "@flue/runtime";
import * as v from "valibot";

/**
 * Shared classifier agent. Default (virtual) sandbox, no host access. Used for
 * cheap structured-output prompts that don't need a shell. Flue 1.0:
 * `defineAgent` replaces `createAgent`; the initializer signature is unchanged.
 * Model is env-overridable so ops can repoint it without a code change.
 */
export const classifier = defineAgent(() => ({
	// `cf-wai` is the custom Workers-AI-over-gateway provider registered in
	// app.ts. Default qwen3-30b-a3b-fp8: chosen by the 43-case sweep (evals/) as
	// the best classifier on cost+speed at near-tied accuracy with kimi-k2.7-code
	// (84% vs 86%), at ~9x cheaper and ~4.4x faster, and with zero capacity
	// timeouts in the sweep (kimi hit 3/43). Override per-run with
	// FLUE_CLASSIFIER_MODEL to compare candidates without a code change.
	model: process.env.FLUE_CLASSIFIER_MODEL ?? "cf-wai/workers-ai/@cf/qwen/qwen3-30b-a3b-fp8",
}));

/**
 * Persist a classifier result to `CLASSIFY_RESULT_PATH` (set by the calling
 * workflow) so the GitHub Actions orchestrator reads it from a file instead of
 * scraping it out of `flue run`'s stdout. flue interleaves build-log lines and
 * pretty-prints the returned value, which defeats both line- and slurp-based
 * stdout parsing -- the parse then silently falls back to `unclear`, stranding
 * every reply. Mirrors investigate.ts's `INVESTIGATE_RESULT_PATH` handoff. When
 * the env var is unset (local prototyping) the write is skipped.
 */
export function persistClassifierResult<T>(result: T): T {
	const path = process.env.CLASSIFY_RESULT_PATH;
	if (path) {
		try {
			writeFileSync(path, JSON.stringify(result));
		} catch (error) {
			console.error("[classify] failed to write result file:", error);
		}
	}
	return result;
}

/**
 * Schema for the issue-classification step that runs at the top of the
 * investigate pipeline. The orchestrator uses the classification to
 * pick which `repro-*` sub-skill to invoke and to decide whether to
 * skip non-bug issues entirely.
 */
export const issueClassificationSchema = v.object({
	kind: v.pipe(
		v.picklist(["bug", "enhancement", "documentation", "question"]),
		v.description("What kind of issue this is. Only `bug` triggers the full pipeline."),
	),
	area: v.pipe(
		v.picklist(["api", "admin", "public", "migration", "build", "other"]),
		v.description("Which part of EmDash the issue lives in. Drives sub-skill choice."),
	),
	requiresBrowser: v.pipe(
		v.boolean(),
		v.description(
			"True for admin or public bugs; selects between agent-browser and pure CLI repro.",
		),
	),
	summary: v.pipe(
		v.string(),
		v.minLength(10),
		v.maxLength(200),
		v.description("One-sentence factual summary of the reported behaviour."),
	),
});

export type IssueClassification = v.InferOutput<typeof issueClassificationSchema>;

/**
 * Schema for the reporter-reply classifier. Decides whether the issue
 * author's reply confirms the fix worked, says it didn't, or is
 * ambiguous and needs a clarifying ask.
 */
export const replyClassificationSchema = v.object({
	classification: v.pipe(
		v.picklist(["positive", "negative", "unclear"]),
		v.description(
			"positive: the reporter confirms the fix works. negative: it doesn't, or the fix is wrong. unclear: neither clearly stated.",
		),
	),
	reasoning: v.pipe(
		v.string(),
		v.minLength(5),
		v.maxLength(400),
		v.description("Short justification quoting the relevant phrase from the reply."),
	),
});

export type ReplyClassification = v.InferOutput<typeof replyClassificationSchema>;

/**
 * Schema for the maintainer-reply classifier. A maintainer addresses the
 * bot (`@emdashbot ...`) on a triage issue; this maps their freeform
 * instruction to one of a fixed set of intents the orchestrator can act
 * on. The `directive` is the implementation guidance passed through to a
 * directed investigate run -- never used to build identifiers or shell.
 */
export const maintainerIntentSchema = v.object({
	intent: v.pipe(
		v.picklist(["implement", "close", "takeover", "unclear"]),
		v.description(
			"implement: the maintainer wants the fix built (approving the proposal or naming a changed approach). close: not a bug / wontfix / by design. takeover: a human is taking over, the bot should disengage. unclear: no actionable instruction.",
		),
	),
	directive: v.pipe(
		v.string(),
		v.maxLength(2000),
		v.description(
			"For implement: the concrete instruction to hand the fix agent (which option to take, what to change). Empty for close/takeover/unclear.",
		),
	),
	reasoning: v.pipe(
		v.string(),
		v.minLength(5),
		v.maxLength(400),
		v.description("Short justification quoting the relevant phrase from the maintainer's comment."),
	),
});

export type MaintainerIntent = v.InferOutput<typeof maintainerIntentSchema>;
