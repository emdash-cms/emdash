import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	EvalRunFailedError,
	EvalRunInProgressError,
	createD1EvalRunStore,
	runIdempotentLiveEvaluation,
	type CompletedEvalRun,
} from "../evals/production.js";

const INPUT = {
	actorDid: "did:web:labels.example:operators:admin",
	role: "admin" as const,
	reason: "Compare the reviewed model bundle before promotion",
	idempotencyKey: "eval-production-001",
	now: new Date("2026-08-25T12:00:00.000Z"),
};

const COMPLETED: CompletedEvalRun = {
	artifactKey: "live/2026-08-25T12:00:00.000Z/candidate.json",
	datasetHash: "d".repeat(64),
	budgetPassed: true,
	failures: [],
	candidateHash: "c".repeat(64),
	promotionComparison: null,
	report: "# Listing metadata AI evaluation\n",
};

beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	await env.DB.prepare("DELETE FROM eval_runs").run();
});

describe("production live evaluation idempotency", () => {
	it("lets only the insert winner execute and replays its stored result", async () => {
		const store = createD1EvalRunStore(env.DB);
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const execute = vi.fn(async () => {
			await blocked;
			return COMPLETED;
		});
		const first = runIdempotentLiveEvaluation({ store, input: INPUT, execute });
		await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));

		await expect(
			runIdempotentLiveEvaluation({ store, input: INPUT, execute }),
		).rejects.toBeInstanceOf(EvalRunInProgressError);
		release();
		const completed = await first;
		await expect(runIdempotentLiveEvaluation({ store, input: INPUT, execute })).resolves.toEqual(
			completed,
		);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("binds actor, role, and reason to the key", async () => {
		const store = createD1EvalRunStore(env.DB);
		await runIdempotentLiveEvaluation({
			store,
			input: INPUT,
			execute: async () => COMPLETED,
		});
		await expect(
			runIdempotentLiveEvaluation({
				store,
				input: { ...INPUT, reason: "A different change ticket" },
				execute: async () => COMPLETED,
			}),
		).rejects.toThrow(/different evaluation request/);
	});

	it("persists a stable failure and does not spend again", async () => {
		const store = createD1EvalRunStore(env.DB);
		const execute = vi.fn(async (): Promise<CompletedEvalRun> => {
			throw new Error("upstream model detail must not be replayed");
		});
		await expect(
			runIdempotentLiveEvaluation({ store, input: INPUT, execute }),
		).rejects.toBeInstanceOf(EvalRunFailedError);
		await expect(
			runIdempotentLiveEvaluation({ store, input: INPUT, execute }),
		).rejects.toMatchObject({ code: "EVALUATION_FAILED" });
		expect(execute).toHaveBeenCalledTimes(1);
		const row = await env.DB.prepare(
			"SELECT status, failure_code, failure_summary FROM eval_runs WHERE idempotency_key = ?",
		)
			.bind(INPUT.idempotencyKey)
			.first();
		expect(row).toEqual({
			status: "failed",
			failure_code: "EVALUATION_FAILED",
			failure_summary: "Protected live evaluation could not be completed",
		});
	});

	it("persists bounded comparison and promotion-review state", async () => {
		const store = createD1EvalRunStore(env.DB);
		const baseline = await store.claim({
			...INPUT,
			idempotencyKey: "eval-baseline-001",
			reason: "Reserve the prior reviewed baseline",
		});
		const promotionComparison = {
			baselineRunId: baseline.record.id,
			schemaVersion: 1 as const,
			datasetHash: "d".repeat(64),
			baselineHash: "b".repeat(64),
			candidateHash: "c".repeat(64),
			comparisonHash: "a".repeat(64),
			changedCases: [],
			metricDelta: {
				invalidOutputs: 0,
				modelErrors: 0,
				repeatedRunDisagreements: 0,
				p95LatencyMs: 2,
				configuredUnits: 0,
			},
			reviewChallengeHash: "e".repeat(64),
		};
		const result = await runIdempotentLiveEvaluation({
			store,
			input: INPUT,
			execute: async () => ({ ...COMPLETED, promotionComparison }),
		});
		expect(result.promotionComparison).toEqual(promotionComparison);
		const row = await env.DB.prepare(
			`SELECT baseline_run_id, baseline_hash, comparison_hash,
			        promotion_challenge_hash, comparison_json, report_markdown
			 FROM eval_runs WHERE id = ?`,
		)
			.bind(result.runId)
			.first();
		expect(row).toMatchObject({
			baseline_run_id: baseline.record.id,
			baseline_hash: "b".repeat(64),
			comparison_hash: "a".repeat(64),
			promotion_challenge_hash: "e".repeat(64),
			report_markdown: COMPLETED.report,
		});
		expect(JSON.parse(String(row?.["comparison_json"]))).toEqual(promotionComparison);
	});
});
