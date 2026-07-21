// Classify a reporter's reply to the bot's verification ask.
//
// Triggered by .github/workflows/reporter-reply.yml when the issue
// author comments on an issue that has the `triage/awaiting-reporter`
// label. The workflow YAML reads the classification from this run's
// output and decides whether to open a PR, retry, or ask for
// clarification.
//
// Cheap kimi prompt, no sandbox, no skills. Just structured output.

import type { FlueContext } from "@flue/runtime";

import { withCapacityRetry } from "../lib/capacity.js";
import {
	classifier,
	persistClassifierResult,
	replyClassificationSchema,
	type ReplyClassification,
} from "../lib/classifier.js";

interface ClassifyReplyPayload {
	issueNumber: number;
	replyBody: string;
	/**
	 * The bot's original ask, so the model can decide what "yes" or
	 * "no" is in reference to. The orchestrator passes the previous
	 * bot comment body verbatim.
	 */
	botAsk?: string;
}

export async function run({
	init,
	payload,
	log,
}: FlueContext<ClassifyReplyPayload>): Promise<ReplyClassification> {
	if (!payload.replyBody) {
		throw new Error("payload.replyBody is required");
	}

	const harness = await init(classifier);
	const session = await harness.session();

	const prompt = [
		"You are reading a GitHub issue reporter's reply to the EmDash investigation bot's verification request.",
		"Decide whether the reply confirms the proposed fix works, says it does not, or is too ambiguous to act on.",
		"",
		"## Bot's ask",
		"",
		payload.botAsk ??
			"(unavailable; assume the bot asked the reporter to install a preview release and confirm whether their bug is fixed)",
		"",
		"## Reporter's reply",
		"",
		payload.replyBody,
		"",
		"## How to decide",
		"",
		"- `positive` -- the reporter clearly says the fix works, the bug is gone, the preview works, or otherwise indicates success.",
		"- `negative` -- the reporter says the fix does not work, the bug persists, they hit a new problem, or the fix is wrong.",
		"- `unclear` -- the reply is off-topic, asks a question without answering, requests changes without confirming or denying, or is too short to tell.",
		"",
		"Default to `unclear` when in doubt. A wrong `positive` opens a PR; a wrong `negative` re-runs an expensive investigation.",
		"",
		"Quote the specific phrase that drove your decision in the reasoning field.",
	].join("\n");

	const { data } = await withCapacityRetry(
		(signal) => session.prompt(prompt, { result: replyClassificationSchema, signal }),
		{
			label: `classify-reply#${payload.issueNumber}`,
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
	log.info("classified reply", {
		issueNumber: payload.issueNumber,
		classification: data.classification,
	});
	return persistClassifierResult(data);
}
