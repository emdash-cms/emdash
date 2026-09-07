import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { sha256Hex } from "../src/ai/hash.js";
import { IMAGE_SYSTEM_PROMPT, TEXT_SYSTEM_PROMPT } from "../src/ai/prompts.js";
import type {
	ImageModerationAdapter,
	ModerationInferenceResult,
	ModerationModelIdentity,
	TextModerationAdapter,
} from "../src/ai/types.js";
import {
	createWorkersAiImageAdapter,
	createWorkersAiTextAdapter,
	type WorkersAiBinding,
} from "../src/ai/workers-ai.js";
import { loadEvalDataset } from "./dataset.js";
import { calculateEvalMetrics, evaluateBudgets, runEvaluation } from "./harness.js";
import { loadRecordedBaseline } from "./recordings.js";
import { evaluateAutoPassReadiness, evaluatePromotionConfidence } from "./report.js";
import type { EvalFixture, EvalResultBundle, SealedEvalDataset } from "./types.js";

const endpoint = process.env.WORKERS_AI_SWEEP_URL;
const outputPath = process.env.MODEL_SWEEP_OUTPUT;
const holdoutPath = process.env.MODEL_SWEEP_HOLDOUT_PATH;
const captureRaw = process.env.MODEL_SWEEP_CAPTURE_RAW === "1";
const repeatCount = Number(process.env.MODEL_SWEEP_REPEATS ?? "1");
const concurrency = Number(process.env.MODEL_SWEEP_CONCURRENCY ?? "3");
const caseConcurrency = Number(process.env.MODEL_SWEEP_CASE_CONCURRENCY ?? "1");
const textModels = parseModels(process.env.MODEL_SWEEP_TEXT_MODELS);
const imageModels = parseModels(process.env.MODEL_SWEEP_IMAGE_MODELS);
const liveFixtureIds = new Set(parseModels(process.env.MODEL_SWEEP_FIXTURE_IDS));
const disableThinkingModels = new Set(parseModels(process.env.MODEL_SWEEP_DISABLE_THINKING_MODELS));
const imageMaxDimension = parseOptionalInteger(process.env.MODEL_SWEEP_IMAGE_MAX_DIMENSION);
const maxCompletionTokens = parseOptionalInteger(process.env.MODEL_SWEEP_MAX_COMPLETION_TOKENS);
const reasoningEffort = parseReasoningEffort(process.env.MODEL_SWEEP_REASONING_EFFORT);

describe("live Workers AI model sweep", () => {
	it("evaluates production adapters against the canonical corpus", async () => {
		if (!endpoint || !outputPath) throw new Error("sweep endpoint and output path are required");
		if (textModels.length + imageModels.length === 0)
			throw new Error("at least one model is required");
		if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 5) {
			throw new Error("MODEL_SWEEP_REPEATS must be between 1 and 5");
		}
		if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
			throw new Error("MODEL_SWEEP_CONCURRENCY must be between 1 and 8");
		}
		if (!Number.isInteger(caseConcurrency) || caseConcurrency < 1 || caseConcurrency > 8) {
			throw new Error("MODEL_SWEEP_CASE_CONCURRENCY must be between 1 and 8");
		}

		const dataset = await loadEvalDataset({
			readFile: (relativePath) =>
				readFile(join(dirname(fileURLToPath(import.meta.url)), "datasets/v1", relativePath)),
			...(holdoutPath ? { protectedHoldout: { fixtureBytes: await readFile(holdoutPath) } } : {}),
		});
		const baseline = loadRecordedBaseline();
		for (const fixtureId of liveFixtureIds) {
			if (!dataset.fixtures.some(({ id }) => id === fixtureId)) {
				throw new Error(`unknown live fixture: ${fixtureId}`);
			}
		}
		const rawResponses: RawProviderResponse[] = [];
		const ai = remoteBinding(
			endpoint,
			imageMaxDimension,
			captureRaw ? (response) => rawResponses.push(response) : undefined,
		);
		const textPromptHash = await sha256Hex(TEXT_SYSTEM_PROMPT);
		const imagePromptHash = await sha256Hex(IMAGE_SYSTEM_PROMPT);
		const runnerCommit = execFileSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		const startedAt = new Date().toISOString();
		const jobs = [
			...textModels.map((model) => ({ lane: "text" as const, model })),
			...imageModels.map((model) => ({ lane: "image" as const, model })),
		];
		const results = await mapConcurrent(jobs, concurrency, async ({ lane, model }) => {
			const started = performance.now();
			try {
				const text = createWorkersAiTextAdapter(ai, {
					modelId: lane === "text" ? model : baseline.textIdentity.modelId,
					promptHash: textPromptHash,
					configuredUnits: 1,
					...(disableThinkingModels.has(model) ? { thinking: false } : {}),
					...(maxCompletionTokens === undefined ? {} : { maxCompletionTokens }),
					...(reasoningEffort === undefined ? {} : { reasoningEffort }),
				});
				const image = createWorkersAiImageAdapter(ai, {
					modelId: lane === "image" ? model : baseline.imageIdentity.modelId,
					promptHash: imagePromptHash,
					configuredUnits: 1,
					...(disableThinkingModels.has(model) ? { thinking: false } : {}),
					...(maxCompletionTokens === undefined ? {} : { maxCompletionTokens }),
					...(reasoningEffort === undefined ? {} : { reasoningEffort }),
				});
				const bundle = await runEvaluation({
					dataset,
					mode: "live",
					repeatCount,
					caseConcurrency,
					textIdentity: text.identity,
					imageIdentity: image.identity,
					runnerCommit,
					executedAt: startedAt,
					createAdapters(fixture: EvalFixture) {
						const fallback = expectedFallbackAdapters(fixture, baseline);
						const live = liveFixtureIds.size === 0 || liveFixtureIds.has(fixture.id);
						return lane === "text"
							? { text: live ? text : fallback.text, image: fallback.image }
							: { text: fallback.text, image: live ? image : fallback.image };
					},
				});
				return resultSummary(lane, model, bundle, performance.now() - started);
			} catch (error) {
				return {
					lane,
					model,
					status: "runner-error" as const,
					durationMs: Math.round(performance.now() - started),
					error: error instanceof Error ? error.message : String(error),
				} satisfies SweepRunnerError;
			}
		});
		const combined = combinedSelection(results, dataset, repeatCount);
		const artifact = {
			schemaVersion: 1,
			startedAt,
			completedAt: new Date().toISOString(),
			runnerCommit,
			datasetVersion: dataset.datasetVersion,
			datasetHash: dataset.datasetHash,
			promotionComplete: dataset.promotionComplete,
			promptHashes: { text: textPromptHash, image: imagePromptHash },
			imageMaxDimension,
			maxCompletionTokens,
			reasoningEffort,
			repeatCount,
			caseConcurrency,
			liveFixtureIds: [...liveFixtureIds],
			...(captureRaw ? { rawResponses } : {}),
			combined,
			results,
		};
		await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
		console.log(JSON.stringify(results.map(compactResult), null, 2));
		expect(results).toHaveLength(jobs.length);
	});
});

afterAll(() => {
	delete process.env.WORKERS_AI_SWEEP_URL;
});

interface RawProviderResponse {
	model: string;
	attempt: number;
	status: number;
	input: Record<string, unknown>;
	output: unknown;
}

function remoteBinding(
	url: string,
	maxDimension: number | undefined,
	onResponse?: (response: RawProviderResponse) => void,
): WorkersAiBinding {
	return {
		async run(model, input) {
			const retryDelays = [250, 1_000, 3_000] as const;
			for (let attempt = 0; ; attempt += 1) {
				const response = await fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						model,
						input,
						...(maxDimension === undefined ? {} : { imageMaxDimension: maxDimension }),
					}),
				});
				const value: unknown = await response.json();
				onResponse?.({
					model,
					attempt: attempt + 1,
					status: response.status,
					input,
					output: value,
				});
				if (response.ok) return value;
				const delay = retryDelays[attempt];
				if ((response.status === 429 || response.status >= 500) && delay !== undefined) {
					await new Promise((done) => setTimeout(done, delay));
					continue;
				}
				const message =
					typeof value === "object" && value !== null && "error" in value
						? String(value.error)
						: `HTTP ${response.status}`;
				throw new Error(message);
			}
		},
	};
}

function combinedSelection(
	results: readonly SweepResult[],
	dataset: SealedEvalDataset,
	repeats: number,
) {
	const text = results.filter(
		(result): result is CompleteSweepResult =>
			result.status === "complete" && result.lane === "text",
	);
	const image = results.filter(
		(result): result is CompleteSweepResult =>
			result.status === "complete" && result.lane === "image",
	);
	if (text.length !== 1 || image.length !== 1) return null;
	const cases = [...text[0]!.cases, ...image[0]!.cases];
	const metrics = calculateEvalMetrics(cases);
	return {
		textModel: text[0]!.model,
		imageModel: image[0]!.model,
		metrics,
		budgetEvaluation: evaluateBudgets(metrics, dataset.budgets, { requireCompleteUsage: true }),
		autoPassReadiness: evaluateAutoPassReadiness(metrics, dataset.budgets),
		promotionConfidence: evaluatePromotionConfidence({ repeatCount: repeats, cases }),
	};
}

function parseOptionalInteger(value: string | undefined): number | undefined {
	if (value === undefined || value === "") return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed)) throw new Error("image max dimension must be an integer");
	return parsed;
}

function parseReasoningEffort(value: string | undefined): "low" | "medium" | "high" | undefined {
	if (value === undefined || value === "") return undefined;
	if (value !== "low" && value !== "medium" && value !== "high") {
		throw new Error("reasoning effort must be low, medium, or high");
	}
	return value;
}

function expectedFallbackAdapters(
	fixture: EvalFixture,
	baseline: ReturnType<typeof loadRecordedBaseline>,
): { text: TextModerationAdapter; image: ImageModerationAdapter } {
	return {
		text: {
			identity: baseline.textIdentity,
			async moderate(request) {
				return expectedFallbackResult(
					fixture,
					[...request.text.map(({ ref }) => ref), ...request.links.map(({ ref }) => ref)],
					baseline.textIdentity,
				);
			},
		},
		image: {
			identity: baseline.imageIdentity,
			async moderate(request) {
				return expectedFallbackResult(fixture, [request.evidenceRef], baseline.imageIdentity);
			},
		},
	};
}

function expectedFallbackResult(
	fixture: EvalFixture,
	evidenceRefs: readonly string[],
	identity: ModerationModelIdentity,
): ModerationInferenceResult {
	const evidenceRef = evidenceRefs[0];
	if (!evidenceRef) throw new Error("sweep fallback requires at least one evidence reference");
	return {
		findings: fixture.expected.categories.map((category) => ({
			category,
			recommendation: "review" as const,
			confidence: 1,
			summary: "Expected result for the non-live sweep lane.",
			evidenceRefs: [evidenceRef],
		})),
		coveredEvidenceRefs: [...evidenceRefs],
		identity,
		latencyMs: 0,
		usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, configuredUnits: 0 },
	};
}

function parseModels(value: string | undefined): string[] {
	if (!value) return [];
	return [
		...new Set(
			value
				.split(",")
				.map((model) => model.trim())
				.filter(Boolean),
		),
	];
}

function resultSummary(
	lane: "text" | "image",
	model: string,
	bundle: EvalResultBundle,
	durationMs: number,
) {
	const cases = bundle.cases.filter((item) => item.kind === lane);
	return {
		lane,
		model,
		status: "complete" as const,
		durationMs: Math.round(durationMs),
		budgetPassed: bundle.budgetEvaluation.passed,
		failures: bundle.budgetEvaluation.failures,
		metrics: bundle.metrics,
		cases,
	};
}

type CompleteSweepResult = ReturnType<typeof resultSummary>;
interface SweepRunnerError {
	lane: "text" | "image";
	model: string;
	status: "runner-error";
	durationMs: number;
	error: string;
}
type SweepResult = CompleteSweepResult | SweepRunnerError;

function compactResult(result: SweepResult) {
	if (result.status !== "complete") return result;
	return {
		lane: result.lane,
		model: result.model,
		status: result.status,
		durationMs: result.durationMs,
		budgetPassed: result.budgetPassed,
		failures: result.failures,
		invalidOutputs: result.metrics.invalidOutputs,
		modelErrors: result.metrics.modelErrors,
		outcomeMismatches: result.metrics.outcomeMismatches,
		repeatedRunDisagreements: result.metrics.repeatedRunDisagreements,
		p95LatencyMs: result.metrics.latencyMs.p95,
	};
}

async function mapConcurrent<Input, Output>(
	items: readonly Input[],
	limit: number,
	callback: (item: Input) => Promise<Output>,
): Promise<Output[]> {
	const output: Array<Output | undefined> = Array.from({ length: items.length });
	let cursor = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (cursor < items.length) {
				const index = cursor++;
				output[index] = await callback(items[index]!);
			}
		}),
	);
	return output.map((value) => {
		if (value === undefined) throw new Error("model sweep worker did not produce a result");
		return value;
	});
}
