import { env as workerEnv } from "cloudflare:workers";

import type { AgentResult, PublicProgressKind } from "./orchestrator.js";
import type { WorkPlanInput } from "./work-plan.js";

export async function applyInvestigationResult(
	input: { issueNumber: number; runId: string },
	result: AgentResult,
	ok: boolean,
	pushed: boolean,
): Promise<true> {
	const { Orchestrator } = workerEnv;
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
	const { Orchestrator } = workerEnv;
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
	const { Orchestrator } = workerEnv;
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
	const { Orchestrator } = workerEnv;
	return Orchestrator.getByName(`issue-${input.issueNumber}`).prepareWorkPlanComment({
		runId: input.runId,
		summary: input.arg?.trim() || input.issueTitle,
	});
}
