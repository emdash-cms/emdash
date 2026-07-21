import { env as workerEnv } from "cloudflare:workers";

import type { AgentResult, OrchestratorDO } from "./orchestrator.js";

export async function applyInvestigationResult(
	input: { issueNumber: number; runId: string },
	result: AgentResult,
	ok: boolean,
	pushed: boolean,
): Promise<true> {
	const orchestrator = workerEnv.Orchestrator as DurableObjectNamespace<OrchestratorDO>;
	const stub = orchestrator.getByName(`issue-${input.issueNumber}`);
	await stub.applyAgentResult({ runId: input.runId, result, ok, pushed });
	return true;
}
