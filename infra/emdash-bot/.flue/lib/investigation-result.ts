import { env as workerEnv } from "cloudflare:workers";

import type { AgentResult, OrchestratorDO, PublicProgressKind } from "./orchestrator.js";
import type { WorkPlanInput } from "./work-plan.js";

interface InvestigationEnv {
	Orchestrator: DurableObjectNamespace<OrchestratorDO>;
}

export async function applyInvestigationResult(
	input: { issueNumber: number; runId: string },
	result: AgentResult,
	ok: boolean,
	pushed: boolean,
): Promise<true> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Wrangler cannot infer Flue-generated RPC class types.
	const { Orchestrator } = workerEnv as unknown as InvestigationEnv;
	const stub = Orchestrator.getByName(`issue-${input.issueNumber}`);
	await stub.applyAgentResult({ runId: input.runId, result, ok, pushed });
	return true;
}

export async function recordInvestigationProgress(
	input: { issueNumber: number; runId: string },
	progress: {
		kind: PublicProgressKind;
		title: string;
		detail?: string | null;
	},
): Promise<boolean> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Wrangler cannot infer Flue-generated RPC class types.
	const { Orchestrator } = workerEnv as unknown as InvestigationEnv;
	try {
		return await Orchestrator.getByName(`issue-${input.issueNumber}`).recordPublicProgress({
			runId: input.runId,
			...progress,
		});
	} catch (error) {
		console.warn("[investigate] public progress write failed", {
			issueNumber: input.issueNumber,
			kind: progress.kind,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

export async function recordWorkPlan(
	input: { issueNumber: number; runId: string },
	plan: WorkPlanInput,
): Promise<boolean> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Wrangler cannot infer Flue-generated RPC class types.
	const { Orchestrator } = workerEnv as unknown as InvestigationEnv;
	return Orchestrator.getByName(`issue-${input.issueNumber}`).updateWorkPlan({
		runId: input.runId,
		...plan,
	});
}

export async function prepareWorkPlanComment(input: {
	issueNumber: number;
	runId: string;
	issueTitle: string;
	arg?: string | null;
}): Promise<boolean> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Wrangler cannot infer Flue-generated RPC class types.
	const { Orchestrator } = workerEnv as unknown as InvestigationEnv;
	return Orchestrator.getByName(`issue-${input.issueNumber}`).prepareWorkPlanComment({
		runId: input.runId,
		summary: input.arg?.trim() || input.issueTitle,
	});
}
