// Unified, state-aware command classifier (Flue 1.0).
//
// Free-text mode: any `@emdashbot <text>` that isn't an exact bare verb is
// routed here by the orchestrator. The classifier is CONSTRAINED to the
// candidate commands valid in the item's current state (passed in `commands`,
// already stripped of destructive actions by the router), so it never picks an
// invalid or hard-to-undo transition -- it returns one of the candidates or
// `none`. This replaces the two narrow classifiers (classify-reply /
// classify-maintainer-reply) with one model call that works in every state.
//
// Cheap kimi prompt, default sandbox, no skills. Structured output only.

import { defineWorkflow, type WorkflowRouteHandler, type WorkflowRunsHandler } from "@flue/runtime";
import * as v from "valibot";

import { withCapacityRetry } from "../lib/capacity.js";
import { classifier, persistClassifierResult } from "../lib/classifier.js";

// HTTP exposure for local `flue dev` so the vitest-evals harness can invoke this
// workflow via @flue/sdk and read its result. The triage project is invoked from
// GitHub Actions and is NOT deployed as a public Worker, so these open handlers
// are only reachable on a local dev server. Do not add these to a deployed,
// publicly-routable Flue app without an auth policy.
export const route: WorkflowRouteHandler = async (_c, next) => next();
export const runs: WorkflowRunsHandler = async (_c, next) => next();

const commandSchema = v.object({
	event: v.string(),
	description: v.string(),
	arg: v.optional(v.nullable(v.string())),
});

const inputSchema = v.object({
	issueNumber: v.number(),
	/** The machine state the item is in, for prompt context. */
	state: v.string(),
	/** The user's comment text (after the `@emdashbot` mention). */
	comment: v.pipe(v.string(), v.minLength(1)),
	/** The bot's last message, so references like "option A" resolve. */
	botContext: v.optional(v.string()),
	/** Candidate commands valid from this state (router.classifierCommands). */
	commands: v.pipe(v.array(commandSchema), v.minLength(1)),
	/**
	 * Optional per-invocation model override (specifier, e.g.
	 * `cf-wai/workers-ai/@cf/zai-org/glm-5.2`). Lets an eval sweep address many
	 * models from one running server. Omitted -> the classifier agent default.
	 */
	model: v.optional(v.string()),
});

export default defineWorkflow({
	agent: classifier,
	input: inputSchema,
	output: v.any(),
	async run({ harness, input, log }) {
		const session = await harness.session();

		// Constrain the model to exactly the candidate events, plus `none`.
		const choices = [...input.commands.map((c) => c.event), "none"];
		const resultSchema = v.object({
			event: v.picklist(choices),
			arg: v.optional(v.string()),
			reasoning: v.pipe(v.string(), v.minLength(3), v.maxLength(400)),
		});

		const actionList = input.commands
			.map((c) => `- \`${c.event}\`: ${c.description}${c.arg ? ` (also set \`arg\`: the ${c.arg})` : ""}`)
			.join("\n");

		const prompt = [
			"You route a comment addressed to the EmDash issue bot to exactly one action.",
			`The item is in state \`${input.state}\`. Choose the single action the comment intends, or \`none\`.`,
			"",
			"## Available actions",
			"",
			actionList,
			"- `none`: the comment has no actionable intent matching the actions above (a question, an aside, or unclear).",
			"",
			"## The bot's last message",
			"",
			input.botContext?.trim() || "(none)",
			"",
			"## The comment",
			"",
			input.comment,
			"",
			"## Rules",
			"",
			"- Pick exactly one `event` from the list above, or `none`.",
			"- If the chosen action takes an `arg`, put a self-contained instruction there the agent can follow WITHOUT re-reading this thread (spell out the concrete approach).",
			"- Prefer `none` over guessing. Only choose an action when the comment clearly intends it.",
			"- Quote the phrase that drove your decision in `reasoning`.",
		].join("\n");

		const res = await withCapacityRetry(
			(signal) =>
				session.prompt(prompt, {
					...(input.model ? { model: input.model } : {}),
					result: resultSchema,
					signal,
				}),
			{
				label: `classify-command#${input.issueNumber}`,
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
		log.info("classified command", { issueNumber: input.issueNumber, state: input.state, event: res.data.event });
		// `_meta` carries usage for eval sweeps; the orchestrator reads only event/arg.
		return persistClassifierResult({
			...res.data,
			_meta: {
				model: res.model ? `${res.model.provider}/${res.model.id}` : input.model ?? null,
				tokens: { input: res.usage.input, output: res.usage.output, total: res.usage.totalTokens },
			},
		});
	},
});
