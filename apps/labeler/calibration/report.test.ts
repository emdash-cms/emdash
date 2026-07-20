import { describe, expect, it } from "vitest";

import { renderReport, summarizeByModel } from "./report.js";
import type { CallRecord, LoadedRun, OutcomeState, RunManifest } from "./types.js";

function record(
	overrides: Partial<CallRecord> & Pick<CallRecord, "fixture" | "modelId">,
): CallRecord {
	return {
		lane: "code",
		promptVersion: "test",
		ok: true,
		outcome: null,
		findings: [],
		coverage: "complete",
		dropped: [],
		call: null,
		diagnostics: null,
		error: null,
		latencyMs: 100,
		expected: null,
		...overrides,
	};
}

function outcome(toState: OutcomeState): CallRecord["outcome"] {
	return { toState, labels: [] };
}

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
	return {
		label: "run",
		timestamp: "2026-07-15T00:00:00Z",
		promptVersion: "test",
		policyVersion: "test.1",
		models: [],
		fixtures: ["clean", "exfil", "obf"],
		codeModels: ["@cf/x/model-a", "@cf/x/model-b"],
		imageModels: [],
		recordCount: 0,
		...overrides,
	};
}

describe("summarizeByModel", () => {
	it("counts agreements, false positives, false negatives, errors, and truncations", () => {
		const records: CallRecord[] = [
			record({
				fixture: "exfil",
				modelId: "@cf/x/model-a",
				outcome: outcome("blocked"),
				expected: { toState: "blocked", categories: ["data-exfiltration"] },
			}),
			record({
				fixture: "clean",
				modelId: "@cf/x/model-a",
				outcome: outcome("blocked"),
				expected: { toState: "passed", categories: [] },
			}),
			record({
				fixture: "noisy",
				modelId: "@cf/x/model-a",
				outcome: outcome("warned"),
				expected: { toState: "passed", categories: [] },
			}),
			record({
				fixture: "exfil",
				modelId: "@cf/x/model-b",
				outcome: outcome("warned"),
				expected: { toState: "blocked", categories: ["data-exfiltration"] },
			}),
			record({
				fixture: "obf",
				modelId: "@cf/x/model-b",
				ok: false,
				error: { name: "ModelTransientError", message: "boom" },
				diagnostics: {
					modelId: "@cf/x/model-b",
					latencyMs: 10,
					httpStatus: 200,
					success: true,
					finishReason: "length",
					usage: null,
					resultKeys: ["choices"],
					contentLength: 0,
					reasoningLength: 4000,
				},
				expected: { review: true, note: "n/a" },
			}),
		];

		const summaries = summarizeByModel(records);
		const a = summaries.find((s) => s.modelId === "@cf/x/model-a");
		const b = summaries.find((s) => s.modelId === "@cf/x/model-b");

		expect(a).toMatchObject({
			agreements: 1,
			falsePositives: 1,
			falseNegatives: 0,
			overWarnings: 1,
			comparable: 3,
		});
		expect(b).toMatchObject({ errors: 1, truncations: 1, falseNegatives: 1 });
	});

	it("scores warn-expected fixtures: warned agrees, passed under-warns, blocked is a false positive", () => {
		const records: CallRecord[] = [
			record({
				fixture: "obf-benign",
				modelId: "@cf/x/model-a",
				outcome: outcome("warned"),
				expected: { toState: "warned", categories: ["obfuscated-code"] },
			}),
			record({
				fixture: "misleading",
				modelId: "@cf/x/model-a",
				outcome: outcome("passed"),
				expected: { toState: "warned", categories: ["misleading-metadata"] },
			}),
			record({
				fixture: "obf-benign",
				modelId: "@cf/x/model-b",
				outcome: outcome("blocked"),
				expected: { toState: "warned", categories: ["obfuscated-code"] },
			}),
		];

		const summaries = summarizeByModel(records);
		const a = summaries.find((s) => s.modelId === "@cf/x/model-a");
		const b = summaries.find((s) => s.modelId === "@cf/x/model-b");

		expect(a).toMatchObject({
			comparable: 2,
			agreements: 1,
			underWarnings: 1,
			overWarnings: 0,
			falsePositives: 0,
			falseNegatives: 0,
		});
		expect(b).toMatchObject({ falsePositives: 1, underWarnings: 0, agreements: 0 });
	});
});

describe("renderReport", () => {
	const run: LoadedRun = {
		manifest: manifest(),
		records: [
			record({
				fixture: "clean",
				modelId: "@cf/x/model-a",
				outcome: outcome("passed"),
				expected: { toState: "passed", categories: [] },
			}),
			record({
				fixture: "exfil",
				modelId: "@cf/x/model-a",
				outcome: outcome("blocked"),
				expected: { toState: "blocked", categories: [] },
			}),
			record({
				fixture: "clean",
				modelId: "@cf/x/model-b",
				outcome: outcome("passed"),
				expected: { toState: "passed", categories: [] },
			}),
			record({
				fixture: "exfil",
				modelId: "@cf/x/model-b",
				outcome: outcome("warned"),
				expected: { toState: "blocked", categories: [] },
			}),
		],
	};

	it("renders the summary and code matrix", () => {
		const markdown = renderReport(run);
		expect(markdown).toContain("Per-model summary");
		expect(markdown).toContain("Code lane outcome matrix");
		expect(markdown).toContain("model-a");
		expect(markdown).toContain("False negatives");
		expect(markdown).toContain("Over-warnings");
		expect(markdown).toContain("Under-warnings");
		expect(markdown).toContain("overwarn");
		expect(markdown).toContain("underwarn");
	});

	it("reports newly blocked and newly allowed against a baseline", () => {
		const base: LoadedRun = {
			manifest: manifest({ label: "baseline" }),
			records: [
				record({
					fixture: "exfil",
					modelId: "@cf/x/model-a",
					outcome: outcome("passed"),
					expected: { toState: "blocked", categories: [] },
				}),
				record({
					fixture: "clean",
					modelId: "@cf/x/model-b",
					outcome: outcome("blocked"),
					expected: { toState: "passed", categories: [] },
				}),
			],
		};
		const markdown = renderReport(run, base);
		expect(markdown).toContain("Diff vs baseline");
		expect(markdown).toContain("Newly blocked (1)");
		expect(markdown).toContain("exfil / code / x/model-a: passed -> blocked");
		expect(markdown).toContain("Newly allowed (1)");
		expect(markdown).toContain("clean / code / x/model-b: blocked -> passed");
	});
});
