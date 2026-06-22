// Classify a maintainer's directive to the investigation bot.
//
// Triggered by .github/workflows/maintainer-reply.yml when someone with a
// real admin/write/triage role on the repo (checked via the permission API,
// not the spoofable author_association) addresses `@emdashbot` on an issue in
// `triage/reproduced` or `triage/by-design`. The workflow YAML reads the intent
// from this run's output and decides whether to dispatch a directed investigate
// run, flag the issue as by-design, disengage, or ask for clarification.
//
// Cheap kimi prompt, no sandbox, no skills. Just structured output.

import type { FlueContext } from "@flue/runtime";

import { withCapacityRetry } from "../lib/capacity.js";
import {
	classifier,
	maintainerIntentSchema,
	persistClassifierResult,
	type MaintainerIntent,
} from "../lib/classifier.js";

interface ClassifyMaintainerReplyPayload {
	issueNumber: number;
	/** The maintainer's comment body, verbatim. */
	replyBody: string;
	/**
	 * The bot's investigation comment, so the model can resolve references
	 * like "go with option A" or "the second one". The orchestrator passes
	 * the latest bot comment body verbatim when one exists.
	 */
	botContext?: string;
}

export async function run({
	init,
	payload,
	log,
}: FlueContext<ClassifyMaintainerReplyPayload>): Promise<MaintainerIntent> {
	if (!payload.replyBody) {
		throw new Error("payload.replyBody is required");
	}

	const harness = await init(classifier);
	const session = await harness.session();

	const prompt = [
		"You are reading a maintainer's reply to the EmDash investigation bot on a GitHub issue.",
		"The bot has already investigated the issue and may have proposed a fix or a set of options.",
		"Map the maintainer's instruction to exactly one intent.",
		"",
		"## Bot's investigation",
		"",
		// Truthiness, not `??`: the orchestrator passes "" (not undefined) when
		// there are no bot comments, and an empty section loses the model's cue.
		// Neutral wording -- this fires for `by-design` too, where the bot found
		// intended behavior rather than reproducing a bug.
		payload.botContext?.trim() ||
			"(unavailable; assume the bot has already investigated this issue)",
		"",
		"## Maintainer's reply",
		"",
		payload.replyBody,
		"",
		"## Intents",
		"",
		'- `implement` -- the maintainer wants the fix built. Covers both approving the bot\'s proposal ("go with option A", "ship it", "yes, do it") and naming a different approach ("use ?url instead of the layer", "do A but namespace it as emdash-admin", "the root cause is right but fix it in X"). Put the concrete instruction in `directive`.',
		"- `close` -- the maintainer says this is not a bug, is intended/by-design, or should be closed/wontfixed.",
		"- `takeover` -- the maintainer is taking this over manually and wants the bot to stop / disengage.",
		"- `unclear` -- a question, an aside, or anything without an actionable instruction.",
		"",
		"## How to decide",
		"",
		"When the maintainer wants the fix built, choose `implement` and put a self-contained instruction in `directive` -- one the fix agent can follow WITHOUT re-reading this conversation, so spell out the chosen option concretely. Reserve `unclear` for a comment with no actionable instruction at all -- a question, an aside, or no decision. Only choose `close`/`takeover` on an explicit close-or-stop instruction: a wrong one disengages the bot.",
		"",
		"Quote the specific phrase that drove your decision in the reasoning field.",
	].join("\n");

	const { data } = await withCapacityRetry(
		(signal) => session.prompt(prompt, { result: maintainerIntentSchema, signal }),
		{
			label: `classify-maintainer-reply#${payload.issueNumber}`,
			attempts: 4,
			perAttemptTimeoutMs: 90_000,
			onRetry: ({ attempt, delayMs, error }) =>
				log.warn?.("model over capacity, backing off", {
					issueNumber: payload.issueNumber,
					attempt,
					delayMs,
					error: String(error),
				}),
		},
	);
	log.info("classified maintainer reply", {
		issueNumber: payload.issueNumber,
		intent: data.intent,
	});
	return persistClassifierResult(data);
}
