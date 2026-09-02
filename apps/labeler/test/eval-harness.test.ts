import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assertDatasetFileHashes, loadEvalDataset } from "../evals/dataset.js";
import { createRecordedEvaluationOptions, runEvaluation } from "../evals/harness.js";
import { loadRecordedBaseline } from "../evals/recordings.js";
import { compareEvalBundles } from "../evals/report.js";
import type { EvalCaseRun } from "../evals/types.js";
import { sha256Hex } from "../src/ai/hash.js";
import { IMAGE_SYSTEM_PROMPT, TEXT_SYSTEM_PROMPT } from "../src/ai/prompts.js";

const DATASET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../evals/datasets/v1");
const readDatasetFile = (relativePath: string) => readFile(resolve(DATASET_ROOT, relativePath));

describe("Workers AI evaluation harness", () => {
	it("keeps holdout fixtures out of the ordinary repository dataset", async () => {
		const publicDataset = await loadEvalDataset({
			readFile: (relativePath) => readFile(resolve(DATASET_ROOT, relativePath)),
		});
		expect(publicDataset.fixtures.some(({ partition }) => partition === "holdout")).toBe(false);
		expect(publicDataset.promotionComplete).toBe(false);
	});

	it("verifies the versioned dataset and media assets byte-for-byte", async () => {
		await expect(
			assertDatasetFileHashes(async (relativePath) =>
				readFile(resolve(DATASET_ROOT, relativePath)),
			),
		).resolves.toBeUndefined();
	});

	it("runs recorded mode offline through production parsers and policy", async () => {
		const dataset = await loadEvalDataset({
			readFile: (relativePath) => readFile(resolve(DATASET_ROOT, relativePath)),
		});
		const baseline = loadRecordedBaseline();
		expect(baseline.textIdentity.promptHash).toBe(await sha256Hex(TEXT_SYSTEM_PROMPT));
		expect(baseline.imageIdentity.promptHash).toBe(await sha256Hex(IMAGE_SYSTEM_PROMPT));
		const bundle = await runEvaluation(
			createRecordedEvaluationOptions({
				dataset,
				...baseline,
				runnerCommit: "test",
				executedAt: "2026-08-24T00:00:00.000Z",
			}),
		);

		expect(bundle.mode).toBe("recorded");
		expect(bundle.metrics.invalidOutputs).toBe(0);
		expect(bundle.metrics.modelErrors, JSON.stringify(bundle.cases)).toBe(0);
		expect(
			bundle.budgetEvaluation,
			JSON.stringify(
				bundle.cases.filter(
					(item) => item.expected.outcome === "pass" && item.runs[0]?.actualOutcome !== "pass",
				),
			),
		).toEqual({ passed: true, failures: [] });
		for (const item of bundle.cases) {
			expect(item.runs[0]?.actualCategories, item.id).toEqual(item.expected.categories.toSorted());
			expect(item.runs[0]?.actualOutcome, item.id).toBe(item.expected.outcome);
		}
		expect((await compareEvalBundles(bundle, bundle)).changedCases).toEqual([]);
	});

	it("resumes at durable case boundaries without repeating completed model work", async () => {
		const dataset = await loadEvalDataset({ readFile: readDatasetFile });
		const base = createRecordedEvaluationOptions({
			dataset,
			...loadRecordedBaseline(),
			runnerCommit: "test",
			executedAt: "2026-08-24T00:00:00.000Z",
		});
		const completed = new Map<string, EvalCaseRun>();
		let interrupt = true;
		let modelCalls = 0;
		const options = {
			...base,
			async runCase(name: string, callback: () => Promise<EvalCaseRun>) {
				if (completed.has(name)) return completed.get(name)!;
				if (interrupt && completed.size === 1) throw new Error("simulated isolate termination");
				const result = await callback();
				modelCalls += 1;
				completed.set(name, result);
				return result;
			},
		};
		await expect(runEvaluation(options)).rejects.toThrow(/isolate termination/);
		interrupt = false;
		await expect(runEvaluation(options)).resolves.toMatchObject({ mode: "recorded" });
		expect(modelCalls).toBe(dataset.fixtures.length);
	});

	it("bounds case concurrency and preserves dataset order", async () => {
		const dataset = await loadEvalDataset({ readFile: readDatasetFile });
		const base = createRecordedEvaluationOptions({
			dataset,
			...loadRecordedBaseline(),
			runnerCommit: "test",
			executedAt: "2026-08-24T00:00:00.000Z",
		});
		let active = 0;
		let maximumActive = 0;
		const bundle = await runEvaluation({
			...base,
			caseConcurrency: 3,
			async runCase(_name, callback) {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				await new Promise((done) => setTimeout(done, 5));
				const result = await callback();
				active -= 1;
				return result;
			},
		});
		expect(maximumActive).toBe(3);
		expect(bundle.cases.map(({ id }) => id)).toEqual(dataset.fixtures.map(({ id }) => id));
	});
});
