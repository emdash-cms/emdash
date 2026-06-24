// Classify a reporter's reply to the bot's verification ask.
//
// Triggered by the orchestrator when the issue author comments on an issue in
// the `awaiting-feedback` state. The orchestrator reads the classification
// from this run and decides whether to open a PR, retry, or ask for clarity.
//
// Cheap kimi prompt, default sandbox, no skills. Just structured output.
//
// Flue 1.0: a discovered `workflows/<name>.ts` default-exports a
// `defineWorkflow({ agent, input, run })`. The harness is initialized for us;
// `payload` is now the validated `input`, and there is no `init()`.

import { defineWorkflow } from "@flue/runtime";
import * as v from "valibot";

import { withCapacityRetry } from "../lib/capacity.js";
import { classifier, persistClassifierResult, replyClassificationSchema } from "../lib/classifier.js";

const inputSchema = v.object({
	issueNumber: v.number(),
	replyBody: v.pipe(v.string(), v.minLength(1)),
	/**
	 * The bot's original ask, so the model can decide what "yes" or "no" is in
	 * reference to. The orchestrator passes the previous bot comment verbatim.
	 */
	botAsk: v.optional(v.string()),
});

export default defineWorkflow({
	agent: classifier,
	input: inputSchema,
	async run({ harness, input, log }) {
		const session = await harness.session();

		const prompt = [
			"You are reading a GitHub issue reporter's reply to the EmDash investigation bot's verification request.",
			"Decide whether the reply confirms the proposed fix works, says it does not, or is too ambiguous to act on.",
			"",
			"## Bot's ask",
			"",
			input.botAsk ??
				"(unavailable; assume the bot asked the reporter to install a preview release and confirm whether their bug is fixed)",
			"",
			"## Reporter's reply",
			"",
			input.replyBody,
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
				label: `classify-reply#${input.issueNumber}`,
				attempts: 4,
				perAttemptTimeoutMs: 90_000,
				onRetry: ({ attempt, delayMs, error }) =>
					log.warn?.("model over capacity, backing off", {
						issueNumber: input.issueNumber,
						attempt,
						delayMs,
						error: String(error),
					}),
			},
		);
		log.info("classified reply", {
			issueNumber: input.issueNumber,
			classification: data.classification,
		});
		return persistClassifierResult(data);
	},
});
