import { flue } from "@flue/runtime/routing";

import type { GatedPr } from "./webhook.js";

const flueApp = flue();

interface AdmissionExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
}

export interface ReviewWorkflowInput extends GatedPr {
	attemptId: string;
	expectedRunId: string;
	deliveryId: string;
	checkRunId: number;
}

export function admitReviewWorkflow(
	input: ReviewWorkflowInput,
	env: Env,
	executionCtx: AdmissionExecutionContext,
): Promise<Response> {
	// Hono and Workers expose slightly different ExecutionContext declarations,
	// but Flue only needs their shared fetch-lifecycle methods here.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	const flueExecutionCtx = executionCtx as Parameters<typeof flueApp.fetch>[2];
	return Promise.resolve(
		flueApp.fetch(
			new Request("https://flue.internal/workflows/review", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input),
			}),
			env,
			flueExecutionCtx,
		),
	);
}
