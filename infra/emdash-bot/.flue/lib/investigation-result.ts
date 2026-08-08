import { env as workerEnv } from "cloudflare:workers";

import type { AgentResult, OrchestratorDO } from "./orchestrator.js";

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
