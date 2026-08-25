import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
	assertSealedEvalDataset,
	loadEvalDataset,
	type ProtectedHoldoutInjection,
} from "../evals/dataset.js";
import {
	calculateEvalMetrics,
	buildCanonicalTextEvalRequest,
	createRecordedEvaluationOptions,
	evaluateBudgets,
	runEvaluation,
} from "../evals/harness.js";
import { assertLiveEvaluationArtifact, runProtectedLiveEvaluation } from "../evals/live.js";
import { readBoundedEvalR2Object } from "../evals/production.js";
import { loadRecordedBaseline } from "../evals/recordings.js";
import {
	authorizePromotionReview,
	assertEvalBundleIntegrity,
	compareEvalBundles,
	consumeAuthorizedPromotionReview,
	createProtectedPromotionRunner,
	createPromotionManifest,
	promotionReviewChallengeHash,
} from "../evals/report.js";
import type { EvalCaseResult, EvalResultBundle } from "../evals/types.js";
import { sha256Hex } from "../src/ai/hash.js";
import { IMAGE_SYSTEM_PROMPT, TEXT_SYSTEM_PROMPT } from "../src/ai/prompts.js";

const nativeAiRun = vi.hoisted(() => vi.fn());

vi.mock("cloudflare:workers", () => ({
	env: { AI: { run: nativeAiRun } },
}));

const DATASET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../evals/datasets/v1");
const readDatasetFile = (relativePath: string) => readFile(resolve(DATASET_ROOT, relativePath));

describe("sealed evaluation datasets", () => {
	it("rejects oversized R2 objects before buffering and accepts the exact boundary", async () => {
		const boundaryBytes = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
		await expect(
			readBoundedEvalR2Object({ size: 4, bytes: boundaryBytes }, 4, "evaluation fixture"),
		).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
		expect(boundaryBytes).toHaveBeenCalledTimes(1);

		const oversizedBytes = vi.fn(async () => new Uint8Array(5));
		await expect(
			readBoundedEvalR2Object({ size: 5, bytes: oversizedBytes }, 4, "evaluation fixture"),
		).rejects.toThrow(/exceeds its byte limit/);
		expect(oversizedBytes).not.toHaveBeenCalled();
	});

	it("computes the dataset identity from exact fixture and asset bytes", async () => {
		const dataset = await loadEvalDataset({ readFile: readDatasetFile });
		expect(() => assertSealedEvalDataset(dataset)).not.toThrow();
		expect(dataset.fixtures.length).toBeGreaterThan(0);
		expect(dataset.datasetHash).toMatch(/^[a-f0-9]{64}$/);

		await expect(
			loadEvalDataset({
				readFile: async (relativePath) => {
					const bytes = await readDatasetFile(relativePath);
					return relativePath === "public.json" ? new Uint8Array([...bytes, 0x20]) : bytes;
				},
			}),
		).rejects.toThrow(/hash mismatch/);
	});

	it("ships only a holdout commitment and rejects an uncommitted protected injection", async () => {
		const dataset = await loadEvalDataset({ readFile: readDatasetFile });
		expect(dataset.fixtures.some(({ partition }) => partition === "holdout")).toBe(false);
		expect(dataset.holdoutCommitment).toMatch(/^[a-f0-9]{64}$/);
		await expect(readDatasetFile("holdout.json")).rejects.toMatchObject({ code: "ENOENT" });

		const protectedHoldout: ProtectedHoldoutInjection = {
			fixtureBytes: new TextEncoder().encode(
				JSON.stringify({ schemaVersion: 1, datasetVersion: "private", fixtures: [] }),
			),
		};
		await expect(loadEvalDataset({ readFile: readDatasetFile, protectedHoldout })).rejects.toThrow(
			/holdout commitment/,
		);
	});

	it("contains prohibited-content cases that also attempt prompt injection", async () => {
		const dataset = await loadEvalDataset({ readFile: readDatasetFile });
		const text = dataset.fixtures.find(({ id }) => id === "prompt-injection-with-phishing-text");
		const image = dataset.fixtures.find(({ id }) => id === "prompt-injection-with-phishing-image");
		expect(text?.expected.categories).toContain("phishing-or-credential-solicitation");
		expect(image?.expected.categories).toContain("phishing-or-credential-solicitation");
	});

	it("sends the complete production canonical profile input to text evals", async () => {
		const dataset = await loadEvalDataset({ readFile: readDatasetFile });
		const fixture = dataset.fixtures.find((item) => item.kind === "text");
		if (!fixture || fixture.kind !== "text") throw new Error("text fixture is missing");
		const request = await buildCanonicalTextEvalRequest(fixture);
		const refs = request.text.map(({ ref }) => ref);
		expect(refs).toEqual(
			expect.arrayContaining([
				"profile.slug",
				"profile.license",
				"profile.authors[0].name",
				"profile.security[0].email",
			]),
		);
	});
});

describe("promotion hardening", () => {
	it("requires identical fixture IDs and dataset hashes for comparisons", async () => {
		const bundle = await recordedBundle();
		const missingCandidate = cloneBundle(bundle);
		missingCandidate.cases = missingCandidate.cases.slice(1);
		await expect(compareEvalBundles(bundle, missingCandidate)).rejects.toThrow(/fixture IDs/);

		const extraBaseline = cloneBundle(bundle);
		extraBaseline.cases = [...extraBaseline.cases, extraBaseline.cases[0]!];
		await expect(compareEvalBundles(extraBaseline, bundle)).rejects.toThrow(/fixture IDs/);

		const otherDataset = cloneBundle(bundle);
		otherDataset.reproducibility.datasetHash = "f".repeat(64);
		await expect(compareEvalBundles(bundle, otherDataset)).rejects.toThrow(/dataset hash/);
	});

	it("reports a fixture when any repeated candidate run changes", async () => {
		const baseline = await recordedBundle();
		const candidate = cloneBundle(baseline);
		candidate.repeatCount = 2;
		candidate.cases = candidate.cases.map((item, index) => ({
			...item,
			runs:
				index === 0
					? [
							item.runs[0]!,
							{
								...item.runs[0]!,
								actualOutcome: "review" as const,
								actualCategories: ["scam-or-spam" as const],
							},
						]
					: [item.runs[0]!, item.runs[0]!],
		}));
		const comparison = await compareEvalBundles(baseline, candidate);
		expect(comparison.changedCases.map(({ id }) => id)).toContain(candidate.cases[0]?.id);
	});

	it("fails live budget evaluation for missing or invalid usage", () => {
		const cases: EvalCaseResult[] = [
			caseResult({}),
			caseResult({ configuredUnits: -1 }),
			caseResult({ configuredUnits: Number.NaN }),
		];
		const metrics = calculateEvalMetrics(cases);
		const result = evaluateBudgets(
			metrics,
			{
				maxFalseNegativesPerCategory: 0,
				maxFalsePositivesPerCategory: 0,
				maxInvalidOutputs: 0,
				maxModelErrors: 0,
				maxBenignReviewRate: 0,
				maxOutcomeMismatches: 0,
				maxRepeatedRunDisagreementRate: 0,
				maxP95LatencyMs: 1_000,
				maxConfiguredUnits: 100,
			},
			{ requireCompleteUsage: true },
		);
		expect(result.passed).toBe(false);
		expect(result.failures).toContain("live usage is missing or invalid");
	});

	it("fails the budget when an outcome disagrees without a category mismatch", () => {
		const mismatch = caseResult({
			inputTokens: 1,
			outputTokens: 1,
			totalTokens: 2,
			configuredUnits: 1,
		});
		mismatch.partition = "holdout";
		mismatch.runs[0]!.actualOutcome = "review";
		const metrics = calculateEvalMetrics([mismatch]);
		expect(metrics.outcomeMismatches).toBe(1);
		expect(
			evaluateBudgets(metrics, {
				maxFalseNegativesPerCategory: 0,
				maxFalsePositivesPerCategory: 0,
				maxInvalidOutputs: 0,
				maxModelErrors: 0,
				maxBenignReviewRate: 0,
				maxOutcomeMismatches: 0,
				maxRepeatedRunDisagreementRate: 0,
				maxP95LatencyMs: 1_000,
				maxConfiguredUnits: 10,
			}),
		).toEqual({ passed: false, failures: ["expected-outcome budget exceeded"] });
	});

	it("acquires the native Workers AI binding internally and rejects an AI override", async () => {
		const dataset = await loadEvalDataset({ readFile: readDatasetFile });
		const input = {
			dataset,
			text: {
				modelId: "@cf/test/text",
				promptHash: await sha256Hex(TEXT_SYSTEM_PROMPT),
				configuredUnits: 1,
			},
			image: {
				modelId: "@cf/test/image",
				promptHash: await sha256Hex(IMAGE_SYSTEM_PROMPT),
				configuredUnits: 1,
			},
			repeatCount: 1,
			runnerCommit: "test",
		};
		nativeAiRun.mockImplementation(async (_model, request) => ({
			response: JSON.stringify({
				schemaVersion: 1,
				findings: [],
				coveredEvidenceRefs: modelEvidenceRefs(request),
			}),
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		}));
		const artifact = await runProtectedLiveEvaluation(input);
		expect(artifact.bundle.mode).toBe("live");
		expect(nativeAiRun).toHaveBeenCalled();

		await expect(
			runProtectedLiveEvaluation({
				...input,
				// @ts-expect-error - production runner never accepts a caller-supplied AI binding
				ai: { run: vi.fn() },
			}),
		).rejects.toThrow(/AI override/);
	});

	it("does not turn a recorded result into a live pass by changing mode or budget fields", async () => {
		const dataset = await loadEvalDataset({ readFile: readDatasetFile });
		const bundle = await recordedBundle(dataset);
		const forged = cloneBundle(bundle);
		forged.mode = "live";
		forged.budgetEvaluation = { passed: true, failures: [] };
		expect(() => assertEvalBundleIntegrity(forged, dataset)).toThrow(/budget result/);
		expect(() => assertLiveEvaluationArtifact({ bundle: forged })).toThrow(
			/live evaluation artifact/,
		);
	});

	it("authenticates and allowlists the reviewer before considering promotion", async () => {
		const challengeHash = "d".repeat(64);
		const consumeCredentialId = vi.fn(async () => true);
		const verifyCredential = vi.fn(async () => ({
			issuer: "https://access.example",
			audience: "plugin-labeler-promotion",
			subject: "did:plc:reviewer",
			authenticatedAt: "2026-08-24T00:00:00.000Z",
			expiresAt: "2026-08-24T00:05:00.000Z",
			credentialId: "access-jti-1",
			challengeHash,
		}));
		const review = await authorizePromotionReview({
			credential: "opaque-access-credential",
			verifyCredential,
			expectedIssuer: "https://access.example",
			expectedAudience: "plugin-labeler-promotion",
			allowedReviewers: ["did:plc:reviewer"],
			challengeHash,
			now: new Date("2026-08-24T00:01:00.000Z"),
			consumeCredentialId,
		});
		expect(review.reviewerDid).toBe("did:plc:reviewer");
		expect(review.challengeHash).toBe(challengeHash);
		expect(consumeCredentialId).toHaveBeenCalledWith({
			issuer: "https://access.example",
			audience: "plugin-labeler-promotion",
			reviewerDid: "did:plc:reviewer",
			credentialId: "access-jti-1",
			challengeHash,
			expiresAt: "2026-08-24T00:05:00.000Z",
		});

		await expect(
			authorizePromotionReview({
				credential: "opaque-access-credential",
				verifyCredential,
				expectedIssuer: "https://access.example",
				expectedAudience: "plugin-labeler-promotion",
				allowedReviewers: ["did:plc:someone-else"],
				challengeHash,
				now: new Date("2026-08-24T00:01:00.000Z"),
				consumeCredentialId,
			}),
		).rejects.toThrow(/allowlisted/);

		await expect(
			authorizePromotionReview({
				credential: "replayed-access-credential",
				verifyCredential,
				expectedIssuer: "https://access.example",
				expectedAudience: "plugin-labeler-promotion",
				allowedReviewers: ["did:plc:reviewer"],
				challengeHash,
				now: new Date("2026-08-24T00:01:00.000Z"),
				consumeCredentialId: async () => false,
			}),
		).rejects.toThrow(/already consumed/);
	});

	it("binds review auth to every promotion hash and consumes an authorization once", async () => {
		const dataset = await loadEvalDataset({ readFile: readDatasetFile });
		const baseline = await recordedBundle(dataset);
		const comparison = await compareEvalBundles(baseline, baseline);
		const challengeHash = await promotionReviewChallengeHash(dataset, comparison);
		for (const key of ["baselineHash", "candidateHash", "comparisonHash"] as const) {
			expect(
				await promotionReviewChallengeHash(dataset, {
					...comparison,
					[key]: "f".repeat(64),
				}),
			).not.toBe(challengeHash);
		}
		await expect(
			promotionReviewChallengeHash(dataset, {
				...comparison,
				datasetHash: "f".repeat(64),
			}),
		).rejects.toThrow(/sealed dataset/);

		const review = await authorizePromotionReview({
			credential: "opaque",
			verifyCredential: async () => ({
				issuer: "issuer",
				audience: "audience",
				subject: "did:plc:reviewer",
				authenticatedAt: "2026-08-24T00:00:00.000Z",
				expiresAt: "2026-08-24T00:05:00.000Z",
				credentialId: "jti-once",
				challengeHash,
			}),
			expectedIssuer: "issuer",
			expectedAudience: "audience",
			allowedReviewers: ["did:plc:reviewer"],
			challengeHash,
			now: new Date("2026-08-24T00:01:00.000Z"),
			consumeCredentialId: async () => true,
		});
		expect(() =>
			consumeAuthorizedPromotionReview(review, {
				challengeHash,
				now: new Date("2026-08-24T00:02:00.000Z"),
			}),
		).not.toThrow();
		expect(() =>
			consumeAuthorizedPromotionReview(review, {
				challengeHash,
				now: new Date("2026-08-24T00:02:00.000Z"),
			}),
		).toThrow(/already used/);
	});

	it("rejects expired review authorization and computes the challenge inside the runner", async () => {
		const dataset = await loadEvalDataset({ readFile: readDatasetFile });
		const baseline = await recordedBundle(dataset);
		const comparison = await compareEvalBundles(baseline, baseline);
		const challengeHash = await promotionReviewChallengeHash(dataset, comparison);
		const review = await authorizePromotionReview({
			credential: "opaque",
			verifyCredential: async () => ({
				issuer: "issuer",
				audience: "audience",
				subject: "did:plc:reviewer",
				authenticatedAt: "2026-08-24T00:00:00.000Z",
				expiresAt: "2026-08-24T00:01:00.000Z",
				credentialId: "jti-expiring",
				challengeHash,
			}),
			expectedIssuer: "issuer",
			expectedAudience: "audience",
			allowedReviewers: ["did:plc:reviewer"],
			challengeHash,
			now: new Date("2026-08-24T00:00:30.000Z"),
			consumeCredentialId: async () => true,
		});
		expect(() =>
			consumeAuthorizedPromotionReview(review, {
				challengeHash,
				now: new Date("2026-08-24T00:01:00.000Z"),
			}),
		).toThrow(/expired/);
		expect(() =>
			consumeAuthorizedPromotionReview(review, {
				challengeHash,
				now: new Date("2026-08-23T23:59:59.000Z"),
			}),
		).toThrow(/not yet valid/);

		const verifyCredential = vi.fn();
		const runner = createProtectedPromotionRunner({
			expectedIssuer: "issuer",
			expectedAudience: "audience",
			allowedReviewers: ["did:plc:reviewer"],
			verifyCredential,
			consumeCredentialId: async () => true,
			now: () => new Date("2026-08-24T00:00:30.000Z"),
		});
		await expect(
			runner.promote({
				credential: "opaque",
				dataset,
				baseline,
				// @ts-expect-error - verifies dataset completeness before accepting any artifact
				candidate: baseline,
			}),
		).rejects.toThrow(/complete partition set/);
		expect(verifyCredential).not.toHaveBeenCalled();
	});

	it("refuses promotion without the protected holdout and a production live artifact", async () => {
		const dataset = await loadEvalDataset({ readFile: readDatasetFile });
		const bundle = await recordedBundle(dataset);
		const review = await authorizePromotionReview({
			credential: "opaque",
			verifyCredential: async () => ({
				issuer: "issuer",
				audience: "audience",
				subject: "did:plc:reviewer",
				authenticatedAt: "2026-08-24T00:00:00.000Z",
				expiresAt: "2026-08-24T00:05:00.000Z",
				credentialId: "jti",
				challengeHash: "e".repeat(64),
			}),
			expectedIssuer: "issuer",
			expectedAudience: "audience",
			allowedReviewers: ["did:plc:reviewer"],
			challengeHash: "e".repeat(64),
			now: new Date("2026-08-24T00:01:00.000Z"),
			consumeCredentialId: async () => true,
		});
		await expect(
			createPromotionManifest({
				dataset,
				baseline: bundle,
				// @ts-expect-error - ordinary bundles are not authenticated live artifacts
				candidate: bundle,
				review,
				now: new Date("2026-08-24T00:02:00.000Z"),
			}),
		).rejects.toThrow(/complete partition set|live evaluation artifact/);
	});
});

async function recordedBundle(dataset?: Awaited<ReturnType<typeof loadEvalDataset>>) {
	const sealed = dataset ?? (await loadEvalDataset({ readFile: readDatasetFile }));
	return runEvaluation(
		createRecordedEvaluationOptions({
			dataset: sealed,
			...loadRecordedBaseline(),
			runnerCommit: "test",
			executedAt: "2026-08-24T00:00:00.000Z",
		}),
	);
}

function cloneBundle(bundle: EvalResultBundle): EvalResultBundle {
	return structuredClone(bundle);
}

function caseResult(usage: Record<string, number>): EvalCaseResult {
	return {
		id: crypto.randomUUID(),
		kind: "text",
		partition: "benign",
		expected: { categories: [], outcome: "pass" },
		disagreed: false,
		runs: [
			{
				status: "complete",
				findings: [],
				actualCategories: [],
				actualOutcome: "pass",
				coveredEvidenceRefs: ["profile.description"],
				latencyMs: 1,
				usage,
			},
		],
	};
}

function modelEvidenceRefs(input: unknown): string[] {
	if (!isRecord(input)) {
		throw new TypeError("model input is invalid");
	}
	const messages = input["messages"];
	if (!Array.isArray(messages)) throw new TypeError("model messages are missing");
	const message = messages[1];
	if (!isRecord(message)) {
		throw new TypeError("model user message is invalid");
	}
	const content = message["content"];
	let encoded: unknown;
	if (typeof content === "string") encoded = content;
	else if (Array.isArray(content)) {
		const first = content[0];
		if (!isRecord(first)) {
			throw new TypeError("model image message is invalid");
		}
		encoded = first["text"];
	}
	if (typeof encoded !== "string") throw new TypeError("model evidence is missing");
	const payload: unknown = JSON.parse(encoded);
	if (!isRecord(payload)) {
		throw new TypeError("model evidence payload is invalid");
	}
	if (typeof payload["evidenceRef"] === "string") return [payload["evidenceRef"]];
	const text = Array.isArray(payload["text"]) ? payload["text"] : [];
	const links = Array.isArray(payload["links"]) ? payload["links"] : [];
	return [...text, ...links].map((field) => {
		if (!isRecord(field)) {
			throw new TypeError("model evidence field is invalid");
		}
		const ref = field["ref"];
		if (typeof ref !== "string") throw new TypeError("model evidence ref is invalid");
		return ref;
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
