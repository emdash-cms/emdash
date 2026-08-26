import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseModerationModelOutput } from "../src/ai/output.js";
import { IMAGE_SYSTEM_PROMPT, MODERATION_OUTPUT_JSON_SCHEMA } from "../src/ai/prompts.js";
import { loadEvalDataset, readSealedEvalAsset } from "./dataset.js";
import type { ImageEvalFixture } from "./types.js";

const endpoint = process.env.WORKERS_AI_SWEEP_URL;
const outputPath = process.env.MODEL_SWEEP_OUTPUT;
const models = [
	...new Set((process.env.MODEL_SWEEP_IMAGE_MODELS ?? "").split(",").filter(Boolean)),
];
const repeatCount = Number(process.env.MODEL_SWEEP_REPEATS ?? "1");
const imageMaxDimension = Number(process.env.MODEL_SWEEP_IMAGE_MAX_DIMENSION ?? "1024");
const fixtureIds = new Set(
	(process.env.MODEL_SWEEP_FIXTURE_IDS ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean),
);

describe("native-interface vision model sweep", () => {
	it("evaluates native image APIs through the canonical moderation parser", async () => {
		if (!endpoint || !outputPath || models.length === 0) {
			throw new Error("native vision sweep endpoint, output, and models are required");
		}
		const dataset = await loadEvalDataset({
			readFile: (relativePath) =>
				readFile(join(dirname(fileURLToPath(import.meta.url)), "datasets/v1", relativePath)),
		});
		const fixtures = dataset.fixtures.filter(
			(fixture): fixture is ImageEvalFixture =>
				fixture.kind === "image" && (fixtureIds.size === 0 || fixtureIds.has(fixture.id)),
		);
		const results = [];
		for (const model of models) {
			const cases = [];
			for (const fixture of fixtures) {
				const bytes = readSealedEvalAsset(dataset, fixture.input.assetId);
				const runs = [];
				for (let repeat = 0; repeat < repeatCount; repeat += 1) {
					const started = performance.now();
					try {
						const response = await fetch(endpoint, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								model,
								imageMaxDimension,
								input: nativeInput(model, bytes, fixture.input.evidenceRef),
							}),
						});
						const raw = await response.text();
						const provider = parseProviderBody(raw);
						if (!response.ok) throw new Error(providerError(provider, response.status));
						const output = nativeOutput(model, provider);
						let parsed;
						try {
							parsed = parseModerationModelOutput(output, [fixture.input.evidenceRef]);
						} catch (error) {
							throw new Error(
								`${error instanceof Error ? error.message : String(error)}; output=${output.slice(0, 1000)}`,
								{ cause: error },
							);
						}
						runs.push({
							status: "complete" as const,
							actualCategories: [
								...new Set(parsed.findings.map(({ category }) => category)),
							].toSorted(),
							actualOutcome: parsed.findings.length === 0 ? ("pass" as const) : ("review" as const),
							latencyMs: performance.now() - started,
						});
					} catch (error) {
						runs.push({
							status: "error" as const,
							actualCategories: [],
							actualOutcome: "error" as const,
							latencyMs: performance.now() - started,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
				cases.push({
					id: fixture.id,
					expected: fixture.expected,
					runs,
					disagreed:
						new Set(runs.map((run) => JSON.stringify([run.actualOutcome, run.actualCategories])))
							.size > 1,
				});
			}
			const allRuns = cases.flatMap(({ runs }) => runs);
			results.push({
				model,
				metrics: {
					exactMismatches: cases.reduce(
						(total, item) =>
							total +
							item.runs.filter(
								(run) =>
									run.actualOutcome !== item.expected.outcome ||
									JSON.stringify(run.actualCategories) !==
										JSON.stringify([...item.expected.categories].toSorted()),
							).length,
						0,
					),
					errors: allRuns.filter(({ status }) => status === "error").length,
					disagreements: cases.filter(({ disagreed }) => disagreed).length,
					p95LatencyMs: percentile(
						allRuns.map(({ latencyMs }) => latencyMs).toSorted((left, right) => left - right),
						0.95,
					),
				},
				cases,
			});
		}
		const artifact = {
			schemaVersion: 1,
			datasetVersion: dataset.datasetVersion,
			datasetHash: dataset.datasetHash,
			repeatCount,
			imageMaxDimension,
			results,
		};
		await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
		console.log(
			JSON.stringify(
				results.map(({ model, metrics }) => ({ model, metrics })),
				null,
				2,
			),
		);
		expect(results).toHaveLength(models.length);
	});
});

function nativeInput(model: string, bytes: Uint8Array, evidenceRef: string) {
	const instruction = `${IMAGE_SYSTEM_PROMPT}\n\nEvidence ref: ${evidenceRef}\nSchema: ${JSON.stringify(MODERATION_OUTPUT_JSON_SCHEMA)}`;
	if (model.includes("/moondream/")) {
		return {
			task: "query",
			image: dataUrl(bytes),
			question: instruction,
			reasoning: false,
			temperature: 0,
			max_tokens: 1024,
		};
	}
	if (model.includes("/llava-")) {
		return { image: [...bytes], prompt: instruction, temperature: 0, seed: 1, max_tokens: 1024 };
	}
	throw new Error(`unsupported native vision model: ${model}`);
}

function parseProviderBody(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		if (!raw.startsWith("data:")) {
			throw new Error(`native vision response is not JSON: ${raw.slice(0, 1000)}`);
		}
	}
	let answer = "";
	for (const line of raw.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const payload = line.slice("data: ".length);
		if (payload === "[DONE]") continue;
		let event: unknown;
		try {
			event = JSON.parse(payload);
		} catch {
			throw new Error("native vision SSE contains invalid JSON");
		}
		if (!isRecord(event) || !isRecord(event["chunk"])) continue;
		const fragment = event["chunk"]["answer"];
		if (typeof fragment === "string") answer = fragment;
	}
	if (!answer) throw new Error("native vision SSE contains no answer output");
	return { answer };
}

function nativeOutput(model: string, provider: unknown): string {
	if (!isRecord(provider)) throw new Error("native vision response must be an object");
	const envelope = isRecord(provider["result"]) ? provider["result"] : provider;
	const output = model.includes("/moondream/") ? envelope["answer"] : envelope["description"];
	if (typeof output !== "string") {
		throw new Error(
			`native vision response is missing text output (keys=${Object.keys(provider).toSorted().join(",")};resultKeys=${
				isRecord(provider["result"]) ? Object.keys(provider["result"]).toSorted().join(",") : "none"
			})`,
		);
	}
	return output;
}

function dataUrl(bytes: Uint8Array): string {
	return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

function providerError(value: unknown, status: number): string {
	return isRecord(value) && typeof value["error"] === "string" ? value["error"] : `HTTP ${status}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function percentile(values: readonly number[], quantile: number): number {
	if (values.length === 0) return 0;
	return values[Math.min(values.length - 1, Math.floor(values.length * quantile))]!;
}
