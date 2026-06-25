// State-aware command classifier.
//
// The Orchestrator DO calls this whenever a free-text `@emdashbot ...` comment
// arrives that's NOT an exact bare verb. The DO supplies the candidate command
// set (already stripped of destructive actions by the router), so the model
// can only pick from valid, safe transitions for the current state, or `none`.
//
// Replaces the two narrow classifiers (classify-reply, classify-maintainer-
// reply) from the previous bot with one model call that works in every state.

import { defineWorkflow, type WorkflowRouteHandler, type WorkflowRunsHandler } from "@flue/runtime";
import * as v from "valibot";

import { classifier } from "../lib/classifier.js";

const commandSchema = v.object({
	event: v.string(),
	description: v.string(),
	arg: v.optional(v.nullable(v.string())),
});

const inputSchema = v.object({
	issueNumber: v.number(),
	state: v.string(),
	comment: v.pipe(v.string(), v.minLength(1)),
	botContext: v.optional(v.string()),
	commands: v.pipe(v.array(commandSchema), v.minLength(1)),
	model: v.optional(v.string()),
});

// HTTP exposure for local dev (`flue dev`) and the vitest-evals harness. The
// public webhook handler in app.ts does NOT proxy these routes; classify-command
// is only invoked from inside the Worker via `invoke()`.
export const route: WorkflowRouteHandler = async (_c, next) => next();
export const runs: WorkflowRunsHandler = async (_c, next) => next();

export default defineWorkflow({
	agent: classifier,
	input: inputSchema,
	output: v.any(),
	async run({ harness, input, log }) {
		const session = await harness.session();

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

		const { data, model, usage } = await session.prompt(prompt, {
			...(input.model ? { model: input.model } : {}),
			result: resultSchema,
		});
		log.info("classified command", {
			issueNumber: input.issueNumber,
			state: input.state,
			event: data.event,
		});
		return {
			...data,
			_meta: {
				model: model ? `${model.provider}/${model.id}` : input.model ?? null,
				tokens: { input: usage.input, output: usage.output, total: usage.totalTokens },
			},
		};
	},
});
