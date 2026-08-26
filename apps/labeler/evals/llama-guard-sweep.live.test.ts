import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadEvalDataset } from "./dataset.js";
import { buildCanonicalTextEvalRequest } from "./harness.js";

const endpoint = process.env.WORKERS_AI_SWEEP_URL;
const outputPath = process.env.MODEL_SWEEP_OUTPUT;
const model = process.env.MODEL_SWEEP_GUARD_MODEL ?? "@cf/meta/llama-guard-3-8b";
const repeatCount = Number(process.env.MODEL_SWEEP_REPEATS ?? "3");

describe("live Llama Guard specialist sweep", () => {
	it("measures binary safety recall without treating Guard categories as listing labels", async () => {
		if (!endpoint || !outputPath) throw new Error("sweep endpoint and output path are required");
		if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 5) {
			throw new Error("MODEL_SWEEP_REPEATS must be between 1 and 5");
		}
		const dataset = await loadEvalDataset({
			readFile: (relativePath) =>
				readFile(join(dirname(fileURLToPath(import.meta.url)), "datasets/v1", relativePath)),
		});
		const fixtures = dataset.fixtures.filter((fixture) => fixture.kind === "text");
		const cases = [];
		for (const fixture of fixtures) {
			const canonical = await buildCanonicalTextEvalRequest(fixture);
			const runs = [];
			for (let repeat = 0; repeat < repeatCount; repeat += 1) {
				const started = performance.now();
				try {
					const response = await fetch(endpoint, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							model,
							input: {
								messages: [
									{
										role: "user",
										content: JSON.stringify({
											schemaVersion: 1,
											text: canonical.text,
											links: canonical.links,
										}),
									},
								],
								max_tokens: 256,
								temperature: 0,
								response_format: { type: "json_object" },
							},
						}),
					});
					const provider: unknown = await response.json();
					if (!response.ok) throw new Error(providerError(provider, response.status));
					const parsed = parseGuardResponse(provider);
					runs.push({
						status: "complete" as const,
						...parsed,
						latencyMs: performance.now() - started,
					});
				} catch (error) {
					runs.push({
						status: "error" as const,
						safe: null,
						categories: [],
						latencyMs: performance.now() - started,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			cases.push({
				id: fixture.id,
				expectedReview: fixture.expected.outcome === "review",
				runs,
				disagreed: new Set(runs.map((run) => JSON.stringify([run.safe, run.categories]))).size > 1,
			});
		}
		const allRuns = cases.flatMap(({ runs }) => runs);
		const artifact = {
			schemaVersion: 1,
			model,
			datasetVersion: dataset.datasetVersion,
			datasetHash: dataset.datasetHash,
			repeatCount,
			metrics: {
				falseNegatives: cases.reduce(
					(total, item) =>
						total + item.runs.filter((run) => item.expectedReview && run.safe === true).length,
					0,
				),
				falsePositives: cases.reduce(
					(total, item) =>
						total + item.runs.filter((run) => !item.expectedReview && run.safe === false).length,
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
		};
		await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
		console.log(JSON.stringify(artifact.metrics, null, 2));
		expect(cases).toHaveLength(fixtures.length);
	});
});

function parseGuardResponse(value: unknown): { safe: boolean; categories: string[] } {
	if (!isRecord(value)) throw new Error("Guard response must be an object");
	const response = value["response"];
	if (isRecord(response)) return guardObject(response);
	if (typeof response !== "string") throw new Error("Guard response is missing output");
	try {
		const parsed: unknown = JSON.parse(response);
		if (isRecord(parsed)) return guardObject(parsed);
	} catch {
		const lines = response.trim().split(/\s+/);
		if (lines[0] === "safe") return { safe: true, categories: [] };
		if (lines[0] === "unsafe") {
			return { safe: false, categories: lines.slice(1).filter((item) => /^S\d+$/.test(item)) };
		}
	}
	throw new Error("Guard output is not recognized");
}

function guardObject(value: Record<string, unknown>): { safe: boolean; categories: string[] } {
	if (typeof value["safe"] !== "boolean" || !Array.isArray(value["categories"])) {
		throw new Error("Guard JSON output is invalid");
	}
	const categories = value["categories"].filter(
		(category): category is string => typeof category === "string" && /^S\d+$/.test(category),
	);
	return { safe: value["safe"], categories };
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
