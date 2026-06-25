// Phase 0 spike: minimal investigate workflow. Stands the agent up inside the
// Cloudflare Sandbox container, runs one structured-output prompt, returns.
//
// The point of this version is to validate the integration end-to-end:
//   1. Worker can spawn the Sandbox DO and have the agent run inside it.
//   2. The agent reaches the Workers AI binding (env.AI) without an API key.
//   3. Structured output via `result: schema` actually works on glm-5.2.
//
// Phase 2 adds the real five-stage pipeline (classify -> reproduce -> diagnose
// -> verify -> fix) with skills, and the agent then needs the toolchain
// (browser, dev server, pnpm) baked into the Dockerfile.

import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from "@flue/runtime";
import { cloudflareSandbox } from "@flue/runtime/cloudflare";
import { getSandbox } from "@cloudflare/sandbox";
import * as v from "valibot";

interface InvestigatePayload {
	issueNumber: number;
	issueTitle: string;
	issueBody: string;
}

const inputSchema = v.object({
	issueNumber: v.number(),
	issueTitle: v.pipe(v.string(), v.minLength(1)),
	issueBody: v.string(),
});

// Minimal classification result: enough to prove structured output works
// against glm-5.2 with the container-bound sandbox. The real pipeline is
// Phase 2.
const resultSchema = v.object({
	kind: v.picklist(["bug", "enhancement", "documentation", "question"]),
	area: v.picklist(["api", "admin", "public", "migration", "build", "other"]),
	requiresBrowser: v.boolean(),
	summary: v.pipe(v.string(), v.minLength(10), v.maxLength(200)),
});

const investigator = defineAgent<Env>(({ id, env }) => ({
	model: "cloudflare/@cf/zai-org/glm-5.2",
	sandbox: cloudflareSandbox(getSandbox(env.Sandbox, id)),
	cwd: "/workspace",
	instructions: [
		"You are EmDash's investigation bot.",
		"For this spike you will be asked to classify one issue. Return strictly the requested schema.",
	].join(" "),
}));

export const route: WorkflowRouteHandler = async (_c, next) => next();

export default defineWorkflow({
	agent: investigator,
	input: inputSchema,
	output: v.any(),
	async run({ harness, input, log }) {
		const session = await harness.session();
		const prompt = [
			"Classify the following EmDash issue.",
			"",
			`Issue #${input.issueNumber}: ${input.issueTitle}`,
			"",
			"## Body",
			"",
			input.issueBody || "(no body)",
			"",
			"## Decide",
			"",
			"- kind: bug | enhancement | documentation | question",
			"- area: api | admin | public | migration | build | other",
			"- requiresBrowser: true for admin/public bugs, false otherwise",
			"- summary: one factual sentence describing the reported behaviour",
			"",
			"Return strictly the requested schema. No prose outside it.",
		].join("\n");
		const { data, model, usage } = await session.prompt(prompt, { result: resultSchema });
		log.info("classified (spike)", { issueNumber: input.issueNumber, ...data });
		return {
			...data,
			_meta: {
				model: model ? `${model.provider}/${model.id}` : null,
				tokens: { input: usage.input, output: usage.output, total: usage.totalTokens },
			},
		};
	},
});
