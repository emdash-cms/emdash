import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";

import {
	createD1EvalRunStore,
	executeProductionLiveEvaluation,
	readProductionEvaluationIdentity,
	type CompletedEvalRun,
	type EvalRunStore,
	type LiveEvaluationWorkflowParams,
	type ProductionEvaluationIdentity,
	type ProductionLiveEvaluationDurability,
} from "./production.js";

const WORKFLOW_READ_RETRY_DELAYS_MS = [250, 1_000] as const;
const MODEL_EVALUATION_STEP_CONFIG = {
	retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
} as const satisfies WorkflowStepConfig;

export interface LiveEvaluationWorkflowResult {
	runId: number;
	status: "succeeded" | "failed";
}

export interface LiveEvaluationWorkflowDependencies {
	store: EvalRunStore;
	execute(runId: number, durability: ProductionLiveEvaluationDurability): Promise<CompletedEvalRun>;
	readIdentity(): Promise<ProductionEvaluationIdentity>;
	wait?(milliseconds: number): Promise<void>;
	now?(): Date;
}

export interface LiveEvaluationDurableStep {
	do<T>(name: string, callback: () => Promise<T>): Promise<T>;
	do<T>(name: string, config: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
}

export async function runBoundLiveEvaluationWorkflow(
	event: Readonly<WorkflowEvent<LiveEvaluationWorkflowParams>>,
	step: LiveEvaluationDurableStep,
	dependencies?: LiveEvaluationWorkflowDependencies,
): Promise<LiveEvaluationWorkflowResult> {
	if (!dependencies) throw new TypeError("live evaluation Workflow dependencies are unavailable");
	assertWorkflowParams(event);
	const now = dependencies.now ?? (() => new Date());
	const wait = dependencies.wait ?? ((milliseconds: number) => scheduler.wait(milliseconds));

	try {
		const currentRun = await step.do("read-evaluation-run", () =>
			dependencies.store.readById(event.payload.runId),
		);
		if (currentRun?.status === "succeeded") {
			return { runId: event.payload.runId, status: "succeeded" };
		}
		if (currentRun?.status === "failed") {
			throw new Error("live evaluation run is already failed");
		}
		assertBoundRun(currentRun, event.payload);
		const boundRun = await step.do("bind-evaluation-run", async () => ({
			runId: currentRun.id,
			idempotencyKey: currentRun.idempotencyKey,
			instanceId: currentRun.workflowInstanceId!,
		}));
		if (
			boundRun.runId !== currentRun.id ||
			boundRun.idempotencyKey !== currentRun.idempotencyKey ||
			boundRun.instanceId !== currentRun.workflowInstanceId
		) {
			throw new Error("live evaluation run binding changed before durable resume");
		}
		const currentIdentity = await retryWorkflowRead(dependencies.readIdentity, wait);
		const boundIdentity = await step.do("bind-evaluation-identity", async () => currentIdentity);
		if (JSON.stringify(boundIdentity) !== JSON.stringify(currentIdentity)) {
			throw new Error("live evaluation runtime identity changed before durable resume");
		}
		const completed = await dependencies.execute(event.payload.runId, {
			executedAt: event.payload.executedAt,
			identity: boundIdentity,
			runCase: (name, callback) =>
				step.do(`evaluate-${name}`, MODEL_EVALUATION_STEP_CONFIG, callback),
			selectBaseline: (callback) => step.do("select-evaluation-baseline", callback),
			async storeArtifact(callback) {
				await step.do("store-evaluation-artifact", async () => {
					await callback();
					return { completed: true };
				});
			},
		});
		const committed = await step.do("complete-evaluation-run", () =>
			dependencies.store.completeWorkflow(
				event.payload.runId,
				event.payload.instanceId,
				completed,
				now(),
			),
		);
		if (!committed) {
			const current = await retryWorkflowRead(
				() => dependencies.store.readById(event.payload.runId),
				wait,
			);
			if (current?.status !== "succeeded") {
				throw new Error("live evaluation Workflow completion was fenced");
			}
		}
		return { runId: event.payload.runId, status: "succeeded" };
	} catch (error) {
		console.error(
			JSON.stringify({
				message: "live evaluation Workflow failed",
				runId: event.payload.runId,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		const current = await retryWorkflowRead(
			() => dependencies.store.readById(event.payload.runId),
			wait,
		);
		if (current?.status === "succeeded") {
			return { runId: event.payload.runId, status: "succeeded" };
		}
		if (current?.status !== "failed") {
			const failed = await step.do("fail-evaluation-run", () =>
				dependencies.store.failWorkflow(
					event.payload.runId,
					event.payload.instanceId,
					"EVALUATION_FAILED",
					"Protected live evaluation could not be completed",
					now(),
				),
			);
			if (!failed) throw error;
		}
		throw new Error("live evaluation Workflow recorded a terminal failure", { cause: error });
	}
}

async function retryWorkflowRead<T>(
	callback: () => Promise<T>,
	wait: (milliseconds: number) => Promise<void>,
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= WORKFLOW_READ_RETRY_DELAYS_MS.length; attempt += 1) {
		try {
			return await callback();
		} catch (error) {
			lastError = error;
		}
		const delay = WORKFLOW_READ_RETRY_DELAYS_MS[attempt];
		if (delay !== undefined) await wait(delay);
	}
	throw lastError;
}

export class LiveEvaluationWorkflow extends WorkflowEntrypoint<Env, LiveEvaluationWorkflowParams> {
	override run(
		event: Readonly<WorkflowEvent<LiveEvaluationWorkflowParams>>,
		step: WorkflowStep,
	): Promise<LiveEvaluationWorkflowResult> {
		return runBoundLiveEvaluationWorkflow(event, step, {
			store: createD1EvalRunStore(this.env.DB),
			execute: (runId, durability) => executeProductionLiveEvaluation(this.env, runId, durability),
			readIdentity: () => readProductionEvaluationIdentity(this.env),
		});
	}
}

function assertBoundRun(
	record: Awaited<ReturnType<EvalRunStore["readById"]>>,
	params: LiveEvaluationWorkflowParams,
): asserts record is NonNullable<typeof record> {
	if (
		!record ||
		record.status !== "running" ||
		record.id !== params.runId ||
		record.idempotencyKey !== params.idempotencyKey ||
		record.workflowInstanceId !== params.instanceId
	) {
		throw new Error("live evaluation Workflow is not bound to its running D1 row");
	}
}

function assertWorkflowParams(event: Readonly<WorkflowEvent<LiveEvaluationWorkflowParams>>): void {
	const value = event.payload;
	if (
		value.schemaVersion !== 1 ||
		!Number.isSafeInteger(value.runId) ||
		value.runId < 1 ||
		value.idempotencyKey.length < 8 ||
		value.idempotencyKey.length > 200 ||
		value.instanceId !== event.instanceId ||
		value.instanceId !== `listing-eval-${value.runId}` ||
		Number.isNaN(Date.parse(value.executedAt))
	) {
		throw new TypeError("live evaluation Workflow parameters are invalid");
	}
}
