// Investigate workflow: runs the agent inside the Cloudflare Sandbox
// container, classifies the issue, and calls back into the OrchestratorDO
// with a structured result.
//
// Phase 1 keeps the body minimal: one structured-output prompt that decides
// whether the agent reproduced the bug, fixed it, or considers it intended.
// Phase 2 will fold in the real five-stage pipeline (classify, reproduce,
// diagnose, verify, fix) with skills and the toolchain.

import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from "@flue/runtime";
import { cloudflareSandbox } from "@flue/runtime/cloudflare";
import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import * as v from "valibot";

const inputSchema = v.object({
	runId: v.pipe(v.string(), v.minLength(1)),
	issueNumber: v.number(),
	mode: v.picklist(["repro", "implement", "revise"]),
	arg: v.optional(v.nullable(v.string())),
	issueTitle: v.pipe(v.string(), v.minLength(1)),
	issueBody: v.string(),
});

const resultSchema = v.object({
	skipped: v.optional(v.boolean()),
	reproduced: v.optional(v.boolean()),
	fixed: v.optional(v.boolean()),
	verdict: v.optional(v.picklist(["bug", "intended-behavior", "unclear"])),
	summary: v.pipe(v.string(), v.minLength(10), v.maxLength(400)),
});

const investigator = defineAgent<Env>(({ id, env }) => ({
	model: "cloudflare/@cf/zai-org/glm-5.2",
	sandbox: cloudflareSandbox(getSandbox(env.Sandbox, id)),
	cwd: "/workspace",
	instructions: [
		"You are EmDash's investigation bot.",
		"You will be asked to investigate one issue in one of three modes:",
		"`repro` (find and verify the bug),",
		"`implement` (build the requested change),",
		"`revise` (re-investigate after PR feedback).",
		"Return strictly the requested schema.",
	].join(" "),
}));

export const route: WorkflowRouteHandler = async (_c, next) => next();

export default defineWorkflow({
	agent: investigator,
	input: inputSchema,
	output: v.any(),
	async run({ harness, input, log }) {
		const session = await harness.session();
		const prompt = buildPrompt(input);
		const { data, model, usage } = await session.prompt(prompt, { result: resultSchema });
		log.info("investigate result", {
			runId: input.runId,
			issueNumber: input.issueNumber,
			mode: input.mode,
			...data,
		});

		// Call back into the OrchestratorDO with the result. The DO is
		// single-threaded so this queues behind any in-flight event() call.
		try {
			const stub = env.Orchestrator.getByName(`issue-${input.issueNumber}`);
			await stub.applyAgentResult({
				runId: input.runId,
				result: data,
				ok: true,
				// Phase 1 has no push step; pushed is always false. Phase 2
				// adds the git push side effect, which sets this to true on
				// successful push of a non-empty diff.
				pushed: false,
			});
		} catch (err) {
			log.error("applyAgentResult callback failed", {
				error: (err as Error).message,
			});
		}

		return {
			...data,
			_meta: {
				model: model ? `${model.provider}/${model.id}` : null,
				tokens: { input: usage.input, output: usage.output, total: usage.totalTokens },
			},
		};
	},
});

function buildPrompt(input: {
	mode: string;
	arg?: string | null;
	issueNumber: number;
	issueTitle: string;
	issueBody: string;
}): string {
	const argSection = input.arg
		? ["", "## Directive", "", input.arg, ""].join("\n")
		: "";
	return [
		`Investigate issue #${input.issueNumber} in mode: ${input.mode}.`,
		"",
		`# ${input.issueTitle}`,
		"",
		input.issueBody || "(no body)",
		argSection,
		"## Return",
		"",
		"- skipped: true if the issue is out of scope (no actionable content)",
		"- reproduced: true if you found the bug in repro mode (false otherwise)",
		"- fixed: true if you applied a fix you believe resolves the issue",
		"- verdict: bug | intended-behavior | unclear",
		"- summary: one or two sentences describing what you found",
		"",
		"Return strictly the requested schema. No prose outside it.",
	].join("\n");
}
