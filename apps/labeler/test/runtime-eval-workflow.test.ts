import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
	WorkflowEntrypoint: class {
		readonly mocked = true;
	},
}));

import type { EvalRunStore, LiveEvaluationWorkflowParams } from "../evals/production.js";
import {
	runBoundLiveEvaluationWorkflow,
	type LiveEvaluationDurableStep,
	type LiveEvaluationWorkflowDependencies,
} from "../evals/workflow.js";

const PARAMS: LiveEvaluationWorkflowParams = {
	schemaVersion: 1,
	runId: 7,
	idempotencyKey: "eval-workflow-007",
	instanceId: "listing-eval-7",
	executedAt: "2026-08-25T12:00:00.000Z",
};

const COMPLETED = {
	artifactKey: "live/candidate.json",
	datasetHash: "d".repeat(64),
	budgetPassed: true,
	failures: [],
	candidateHash: "c".repeat(64),
	promotionComparison: null,
	report: "# Evaluation\n",
};

const IDENTITY = {
	schemaVersion: 1 as const,
	datasetVersion: "dataset-v1",
	datasetHash: "d".repeat(64),
	budgetHash: "b".repeat(64),
	runnerVersion: "runner-v1",
	runnerCommit: "commit-v1",
	repeatCount: 3 as const,
	textModelId: "text-model",
	textPromptHash: "1".repeat(64),
	imageModelId: "image-model",
	imagePromptHash: "2".repeat(64),
};

describe("live evaluation Workflow", () => {
	it("completes through stable instance fencing and durable case/artifact steps", async () => {
		const step = new MemoryStep();
		const store = memoryStore();
		const spend = vi.fn(async () => ({
			status: "complete" as const,
			findings: [],
			actualCategories: [],
			actualOutcome: "pass" as const,
			coveredEvidenceRefs: ["profile.name"],
			latencyMs: 1,
			usage: {},
		}));
		const result = await runBoundLiveEvaluationWorkflow(
			{
				instanceId: PARAMS.instanceId,
				workflowName: "eval",
				payload: PARAMS,
				timestamp: new Date("2026-08-25T12:00:00.000Z"),
			},
			step,
			{
				store,
				async execute(_runId, durability) {
					await durability.runCase("case-0-repeat-0", spend);
					await durability.selectBaseline(async () => null);
					await durability.storeArtifact(async () => undefined);
					return COMPLETED;
				},
				readIdentity: async () => IDENTITY,
				now: () => new Date("2026-08-25T12:01:00.000Z"),
			},
		);
		expect(result).toEqual({ runId: 7, status: "succeeded" });
		expect(spend).toHaveBeenCalledTimes(1);
		expect(step.calls).toEqual([
			"read-evaluation-run",
			"bind-evaluation-run",
			"bind-evaluation-identity",
			"evaluate-case-0-repeat-0",
			"select-evaluation-baseline",
			"store-evaluation-artifact",
			"complete-evaluation-run",
		]);
		expect(store.completeWorkflow).toHaveBeenCalledWith(
			7,
			"listing-eval-7",
			COMPLETED,
			new Date("2026-08-25T12:01:00.000Z"),
		);
	});

	it("records failure for status queries and leaves the Workflow errored", async () => {
		const step = new MemoryStep();
		const store = memoryStore();
		await expect(
			runBoundLiveEvaluationWorkflow(
				{
					instanceId: PARAMS.instanceId,
					workflowName: "eval",
					payload: PARAMS,
					timestamp: new Date("2026-08-25T12:00:00.000Z"),
				},
				step,
				{
					store,
					execute: async () => {
						throw new Error("Workers AI unavailable");
					},
					readIdentity: async () => IDENTITY,
					now: () => new Date("2026-08-25T12:01:00.000Z"),
				},
			),
		).rejects.toThrow(/terminal failure/);
		expect(store.failWorkflow).toHaveBeenCalledWith(
			7,
			"listing-eval-7",
			"EVALUATION_FAILED",
			"Protected live evaluation could not be completed",
			new Date("2026-08-25T12:01:00.000Z"),
		);
	});

	it("resumes cached cases after the former lease TTL without repeating model spend", async () => {
		const step = new MemoryStep();
		step.results.set("bind-evaluation-run", {
			runId: PARAMS.runId,
			idempotencyKey: PARAMS.idempotencyKey,
			instanceId: PARAMS.instanceId,
		});
		step.results.set("bind-evaluation-identity", IDENTITY);
		step.results.set("evaluate-case-0-repeat-0", {
			status: "complete",
			findings: [],
			actualCategories: [],
			actualOutcome: "pass",
			coveredEvidenceRefs: ["profile.name"],
			latencyMs: 1,
			usage: {},
		});
		const store = memoryStore();
		const spend = vi.fn(async () => ({
			status: "complete" as const,
			findings: [],
			actualCategories: [],
			actualOutcome: "pass" as const,
			coveredEvidenceRefs: ["profile.description"],
			latencyMs: 1,
			usage: {},
		}));
		await runBoundLiveEvaluationWorkflow(
			{
				instanceId: PARAMS.instanceId,
				workflowName: "eval",
				payload: PARAMS,
				timestamp: new Date("2026-08-26T12:00:00.000Z"),
			},
			step,
			{
				store,
				async execute(_runId, durability) {
					await durability.runCase("case-0-repeat-0", spend);
					await durability.runCase("case-1-repeat-0", spend);
					await durability.selectBaseline(async () => null);
					await durability.storeArtifact(async () => undefined);
					return COMPLETED;
				},
				readIdentity: async () => IDENTITY,
				now: () => new Date("2026-08-26T12:01:00.000Z"),
			},
		);
		expect(spend).toHaveBeenCalledTimes(1);
	});

	it("retries transient run and identity reads before any model work", async () => {
		const step = new RetryingMemoryStep();
		const baseStore = memoryStore();
		const stableRead = baseStore.readById;
		const readById = vi
			.fn<EvalRunStore["readById"]>()
			.mockRejectedValueOnce(new Error("transient D1 read failure"))
			.mockImplementation(stableRead);
		const readIdentity = vi
			.fn<LiveEvaluationWorkflowDependencies["readIdentity"]>()
			.mockRejectedValueOnce(new Error("transient R2 read failure"))
			.mockRejectedValueOnce(new Error("transient R2 read failure"))
			.mockResolvedValue(IDENTITY);
		const wait = vi.fn(async (_milliseconds: number) => undefined);
		const spend = vi.fn(async () => ({
			status: "complete" as const,
			findings: [],
			actualCategories: [],
			actualOutcome: "pass" as const,
			coveredEvidenceRefs: ["profile.name"],
			latencyMs: 1,
			usage: {},
		}));
		await expect(
			runBoundLiveEvaluationWorkflow(
				{
					instanceId: PARAMS.instanceId,
					workflowName: "eval",
					payload: PARAMS,
					timestamp: new Date("2026-08-25T12:00:00.000Z"),
				},
				step,
				{
					store: { ...baseStore, readById },
					async execute(_runId, durability) {
						await durability.runCase("case-0-repeat-0", spend);
						await durability.selectBaseline(async () => null);
						await durability.storeArtifact(async () => undefined);
						return COMPLETED;
					},
					readIdentity,
					wait,
				},
			),
		).resolves.toEqual({ runId: PARAMS.runId, status: "succeeded" });
		expect(readById).toHaveBeenCalledTimes(2);
		expect(readIdentity).toHaveBeenCalledTimes(3);
		expect(wait).toHaveBeenNthCalledWith(1, 250);
		expect(wait).toHaveBeenNthCalledWith(2, 1_000);
		expect(spend).toHaveBeenCalledTimes(1);
	});

	it("fails before cached model steps when the runtime identity changes", async () => {
		const step = new MemoryStep();
		step.results.set("bind-evaluation-identity", IDENTITY);
		const store = memoryStore();
		const execute = vi.fn(async () => COMPLETED);
		await expect(
			runBoundLiveEvaluationWorkflow(
				{
					instanceId: PARAMS.instanceId,
					workflowName: "eval",
					payload: PARAMS,
					timestamp: new Date("2026-08-26T12:00:00.000Z"),
				},
				step,
				{
					store,
					execute,
					readIdentity: async () => ({ ...IDENTITY, runnerCommit: "changed-commit" }),
				},
			),
		).rejects.toThrow(/terminal failure/);
		expect(execute).not.toHaveBeenCalled();
	});
});

class MemoryStep implements LiveEvaluationDurableStep {
	readonly calls: string[] = [];
	readonly results = new Map<string, unknown>();

	async do<T>(name: string, callback: () => Promise<T>): Promise<T>;
	async do<T>(
		name: string,
		config: { retries?: unknown; timeout?: unknown },
		callback: () => Promise<T>,
	): Promise<T>;
	async do<T>(
		name: string,
		configOrCallback: { retries?: unknown; timeout?: unknown } | (() => Promise<T>),
		callback?: () => Promise<T>,
	): Promise<T> {
		if (name.startsWith("evaluate-") && typeof configOrCallback === "function") {
			throw new Error("model evaluation step is not bounded");
		}
		if (
			name.startsWith("evaluate-") &&
			typeof configOrCallback !== "function" &&
			!configOrCallback.retries
		) {
			throw new Error("model evaluation step has no retries");
		}
		if (this.results.has(name)) return this.results.get(name) as T;
		this.calls.push(name);
		const result = await (callback ?? (configOrCallback as () => Promise<T>))();
		this.results.set(name, result);
		return result;
	}
}

class RetryingMemoryStep extends MemoryStep {
	override async do<T>(name: string, callback: () => Promise<T>): Promise<T>;
	override async do<T>(
		name: string,
		config: { retries?: unknown; timeout?: unknown },
		callback: () => Promise<T>,
	): Promise<T>;
	override async do<T>(
		name: string,
		configOrCallback: { retries?: unknown; timeout?: unknown } | (() => Promise<T>),
		callback?: () => Promise<T>,
	): Promise<T> {
		if (this.results.has(name)) return this.results.get(name) as T;
		this.calls.push(name);
		const execute = callback ?? (configOrCallback as () => Promise<T>);
		let result: T;
		try {
			result = await execute();
		} catch {
			result = await execute();
		}
		this.results.set(name, result);
		return result;
	}
}

function memoryStore(): EvalRunStore & {
	completeWorkflow: ReturnType<typeof vi.fn<EvalRunStore["completeWorkflow"]>>;
	failWorkflow: ReturnType<typeof vi.fn<EvalRunStore["failWorkflow"]>>;
} {
	return {
		claim: async () => {
			throw new Error("unused");
		},
		renew: async () => true,
		complete: async () => true,
		fail: async () => true,
		readById: async () => ({
			id: PARAMS.runId,
			idempotencyKey: PARAMS.idempotencyKey,
			actorDid: "did:web:labels.example:operators:admin",
			role: "admin",
			reason: "Run evaluation",
			now: new Date(PARAMS.executedAt),
			status: "running",
			createdAt: PARAMS.executedAt,
			workflowInstanceId: PARAMS.instanceId,
		}),
		readByIdempotencyKey: async () => null,
		bindWorkflow: async () => true,
		completeWorkflow: vi.fn(async () => true),
		failWorkflow: vi.fn(async () => true),
	};
}
