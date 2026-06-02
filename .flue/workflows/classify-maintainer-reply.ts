// Classify a maintainer's directive to the investigation bot.
//
// Triggered by .github/workflows/maintainer-reply.yml when a maintainer
// (OWNER/MEMBER/COLLABORATOR) addresses `@emdashbot` on an issue carrying
// a `triage/*` label. The workflow YAML reads the intent from this run's
// output and decides whether to dispatch a directed investigate run, flag the
// issue as by-design, disengage, or ask for clarification.
//
// Cheap kimi prompt, no sandbox, no skills. Just structured output.

import type { FlueContext } from "@flue/runtime";

import { classifier, maintainerIntentSchema, type MaintainerIntent } from "../lib/classifier.js";

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
		payload.botContext ??
			"(unavailable; assume the bot reproduced the issue and either proposed options or pushed a candidate fix)",
		"",
		"## Maintainer's reply",
		"",
		payload.replyBody,
		"",
		"## Intents",
		"",
		'- `proceed` -- the maintainer approves implementing the fix as discussed (e.g. "go with option A", "ship it", "implement that", "yes, do it"). Capture which option / approach they chose in `directive`.',
		'- `steer` -- the maintainer wants it implemented but DIFFERENTLY from what the bot proposed (e.g. "use ?url instead of the layer", "do A but namespace it as emdash-admin", "the root cause is right but fix it in X"). Capture the changed instruction in `directive`.',
		"- `close` -- the maintainer says this is not a bug, is intended/by-design, or should be closed/wontfixed.",
		"- `takeover` -- the maintainer is taking this over manually and wants the bot to stop / disengage.",
		"- `unclear` -- a question, an aside, or anything without an actionable instruction.",
		"",
		"## How to decide between proceed and steer",
		"",
		"If the maintainer names changes the bot did not already propose, it's `steer`. If they just pick from / approve what the bot already laid out, it's `proceed`. When a directed fix is warranted (proceed or steer), `directive` must be a self-contained instruction the fix agent can follow WITHOUT re-reading this conversation -- spell out the chosen option concretely.",
		"",
		"Default to `unclear` when there is no clear instruction. A wrong `proceed`/`steer` runs an expensive fix; a wrong `close`/`takeover` disengages the bot.",
		"",
		"Quote the specific phrase that drove your decision in the reasoning field.",
	].join("\n");

	const { data } = await session.prompt(prompt, { result: maintainerIntentSchema });
	log.info("classified maintainer reply", {
		issueNumber: payload.issueNumber,
		intent: data.intent,
	});
	return data;
}
