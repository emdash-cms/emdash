import { MODERATION_FINDING_CATEGORIES } from "@emdash-cms/registry-moderation";

import { sha256Hex } from "../src/ai/hash.js";
import type { ModerationModelIdentity } from "../src/ai/types.js";
import { PROMOTION_REQUIRED_PARTITIONS, assertSealedEvalDataset } from "./dataset.js";
import { calculateEvalMetrics, evaluateBudgets, EVAL_RUNNER_VERSION } from "./harness.js";
import { assertLiveEvaluationArtifact, type LiveEvaluationArtifact } from "./live.js";
import type {
	EvalBudgets,
	EvalComparison,
	EvalMetrics,
	EvalResultBundle,
	SealedEvalDataset,
} from "./types.js";

const authorizedPromotionReviewBrand: unique symbol = Symbol("authorizedPromotionReview");
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const PROMOTION_MIN_REPEAT_COUNT = 3;
const PROMOTION_MIN_PROTECTED_REVIEW_FIXTURES = 300;
const PROMOTION_MIN_PROTECTED_PASS_FIXTURES = 100;
const PROMOTION_MIN_PROTECTED_IMAGE_FIXTURES = 100;
const PROMOTION_MIN_PROTECTED_FIXTURES_PER_CATEGORY = 30;
const PROMOTION_MAX_UNSAFE_PASS_RATE_UPPER_BOUND_95 = 0.01;

export interface PromotionConfidenceEvaluation {
	passed: boolean;
	failures: readonly string[];
	evidence: {
		protectedFixtures: number;
		protectedReviewFixtures: number;
		protectedPassFixtures: number;
		protectedImageFixtures: number;
		protectedFixturesByCategory: Record<string, number>;
		unsafePasses: number;
		unsafePassRateUpperBound95: number;
	};
}

export interface PromotionAuthenticationClaims {
	issuer: string;
	audience: string;
	subject: string;
	authenticatedAt: string;
	expiresAt: string;
	credentialId: string;
	challengeHash: string;
}

export interface AuthorizedPromotionReview {
	reviewerDid: string;
	authenticatedAt: string;
	expiresAt: string;
	challengeHash: string;
	authority: {
		issuer: string;
		audience: string;
		credentialId: string;
		challengeHash: string;
		expiresAt: string;
	};
	readonly [authorizedPromotionReviewBrand]: true;
}

export interface AuthenticatedModelPromotion {
	schemaVersion: 1;
	status: "approved";
	policyVersion: string;
	datasetHash: string;
	reportHash: string;
	reviewedAt: string;
	reviewedBy: string;
	text: ModerationModelIdentity;
	image: ModerationModelIdentity;
	baselineHash: string;
	candidateHash: string;
	comparisonHash: string;
	authorization: AuthorizedPromotionReview["authority"];
}

export interface PromotionAuthority {
	expectedIssuer: string;
	expectedAudience: string;
	allowedReviewers: readonly string[];
	verifyCredential(credential: string): Promise<PromotionAuthenticationClaims>;
	consumeCredentialId(input: {
		issuer: string;
		audience: string;
		reviewerDid: string;
		credentialId: string;
		challengeHash: string;
		expiresAt: string;
	}): Promise<boolean>;
	now(): Date;
}

export interface ProtectedPromotionRunner {
	promote(input: {
		credential: string;
		dataset: SealedEvalDataset;
		baseline: EvalResultBundle;
		candidate: LiveEvaluationArtifact;
	}): Promise<AuthenticatedModelPromotion>;
}

const authorizedReviews = new WeakSet<object>();
const consumedReviews = new WeakSet<object>();

export async function authorizePromotionReview(input: {
	credential: string;
	verifyCredential(credential: string): Promise<PromotionAuthenticationClaims>;
	expectedIssuer: string;
	expectedAudience: string;
	allowedReviewers: readonly string[];
	challengeHash: string;
	now: Date;
	consumeCredentialId(input: {
		issuer: string;
		audience: string;
		reviewerDid: string;
		credentialId: string;
		challengeHash: string;
		expiresAt: string;
	}): Promise<boolean>;
}): Promise<AuthorizedPromotionReview> {
	if (
		!input.credential ||
		input.allowedReviewers.length === 0 ||
		!SHA256_HEX_RE.test(input.challengeHash) ||
		Number.isNaN(input.now.getTime())
	) {
		throw new TypeError("promotion authentication configuration is invalid");
	}
	const claims = await input.verifyCredential(input.credential);
	const authenticatedAt = Date.parse(claims.authenticatedAt);
	const expiresAt = Date.parse(claims.expiresAt);
	const now = input.now.getTime();
	if (
		claims.issuer !== input.expectedIssuer ||
		claims.audience !== input.expectedAudience ||
		!claims.credentialId ||
		claims.challengeHash !== input.challengeHash ||
		Number.isNaN(authenticatedAt) ||
		Number.isNaN(expiresAt) ||
		authenticatedAt > now ||
		expiresAt <= now ||
		expiresAt - authenticatedAt > 15 * 60 * 1_000
	) {
		throw new Error("promotion credential claims do not match the configured authority");
	}
	if (!input.allowedReviewers.includes(claims.subject)) {
		throw new Error("authenticated promotion reviewer is not allowlisted");
	}
	if (
		!(await input.consumeCredentialId({
			issuer: claims.issuer,
			audience: claims.audience,
			reviewerDid: claims.subject,
			credentialId: claims.credentialId,
			challengeHash: input.challengeHash,
			expiresAt: claims.expiresAt,
		}))
	) {
		throw new Error("promotion credential was already consumed");
	}
	const review = Object.freeze<AuthorizedPromotionReview>({
		reviewerDid: claims.subject,
		authenticatedAt: claims.authenticatedAt,
		expiresAt: claims.expiresAt,
		challengeHash: input.challengeHash,
		authority: Object.freeze({
			issuer: claims.issuer,
			audience: claims.audience,
			credentialId: claims.credentialId,
			challengeHash: input.challengeHash,
			expiresAt: claims.expiresAt,
		}),
		[authorizedPromotionReviewBrand]: true,
	});
	authorizedReviews.add(review);
	return review;
}

export function createProtectedPromotionRunner(
	authority: PromotionAuthority,
): ProtectedPromotionRunner {
	if (
		!authority.expectedIssuer ||
		!authority.expectedAudience ||
		authority.allowedReviewers.length === 0
	) {
		throw new TypeError("promotion authority configuration is invalid");
	}
	return Object.freeze<ProtectedPromotionRunner>({
		async promote(input) {
			const prepared = await preparePromotion(input);
			const review = await authorizePromotionReview({
				credential: input.credential,
				verifyCredential: authority.verifyCredential,
				expectedIssuer: authority.expectedIssuer,
				expectedAudience: authority.expectedAudience,
				allowedReviewers: authority.allowedReviewers,
				challengeHash: prepared.challengeHash,
				now: authority.now(),
				consumeCredentialId: authority.consumeCredentialId,
			});
			return createPromotionManifest({ ...input, review, now: authority.now() });
		},
	});
}

export async function compareEvalBundles(
	baseline: EvalResultBundle,
	candidate: EvalResultBundle,
): Promise<EvalComparison> {
	if (baseline.reproducibility.datasetHash !== candidate.reproducibility.datasetHash) {
		throw new Error("baseline and candidate dataset hash must match exactly");
	}
	if (baseline.reproducibility.datasetVersion !== candidate.reproducibility.datasetVersion) {
		throw new Error("baseline and candidate dataset version must match exactly");
	}
	assertExactFixtureIds(baseline.cases, candidate.cases);
	const baselineCases = new Map(baseline.cases.map((item) => [item.id, item]));
	const changedCases = candidate.cases.flatMap((item) => {
		const previous = baselineCases.get(item.id)!;
		const before = previous.runs[0]!;
		const after = item.runs.find(
			(run) =>
				before.actualOutcome !== run.actualOutcome ||
				JSON.stringify(before.actualCategories) !== JSON.stringify(run.actualCategories),
		);
		if (!after) return [];
		return [
			{
				id: item.id,
				baselineCategories: before.actualCategories,
				candidateCategories: after.actualCategories,
				baselineOutcome: before.actualOutcome,
				candidateOutcome: after.actualOutcome,
			},
		];
	});
	const comparison = {
		schemaVersion: 1 as const,
		datasetHash: candidate.reproducibility.datasetHash,
		baselineHash: await hashBundle(baseline),
		candidateHash: await hashBundle(candidate),
		changedCases,
		metricDelta: {
			invalidOutputs: candidate.metrics.invalidOutputs - baseline.metrics.invalidOutputs,
			modelErrors: candidate.metrics.modelErrors - baseline.metrics.modelErrors,
			outcomeMismatches: candidate.metrics.outcomeMismatches - baseline.metrics.outcomeMismatches,
			repeatedRunDisagreements:
				candidate.metrics.repeatedRunDisagreements - baseline.metrics.repeatedRunDisagreements,
			p95LatencyMs: candidate.metrics.latencyMs.p95 - baseline.metrics.latencyMs.p95,
			configuredUnits:
				candidate.metrics.usage.configuredUnits - baseline.metrics.usage.configuredUnits,
		},
	};
	return {
		...comparison,
		comparisonHash: await sha256Hex(stableJson(comparison)),
	};
}

export function evaluatePromotionConfidence(
	bundle: Pick<EvalResultBundle, "repeatCount" | "cases">,
): PromotionConfidenceEvaluation {
	const protectedCases = bundle.cases.filter(({ partition }) => partition === "holdout");
	const reviewCases = protectedCases.filter(({ expected }) => expected.outcome === "review");
	const passCases = protectedCases.filter(({ expected }) => expected.outcome === "pass");
	const imageCases = protectedCases.filter(({ kind }) => kind === "image");
	const categoryCounts = Object.fromEntries(
		MODERATION_FINDING_CATEGORIES.map((category) => [
			category,
			protectedCases.filter(({ expected }) => expected.categories.includes(category)).length,
		]),
	);
	const unsafePasses = reviewCases.filter(({ runs }) =>
		runs.some(({ actualOutcome }) => actualOutcome === "pass"),
	).length;
	const unsafePassRateUpperBound95 =
		unsafePasses === 0 && reviewCases.length > 0 ? 1 - 0.05 ** (1 / reviewCases.length) : 1;
	const failures: string[] = [];
	if (bundle.repeatCount < PROMOTION_MIN_REPEAT_COUNT) {
		failures.push("promotion repeat minimum not met");
	}
	if (
		protectedCases.length <
		PROMOTION_MIN_PROTECTED_REVIEW_FIXTURES + PROMOTION_MIN_PROTECTED_PASS_FIXTURES
	) {
		failures.push("protected fixture minimum not met");
	}
	if (reviewCases.length < PROMOTION_MIN_PROTECTED_REVIEW_FIXTURES) {
		failures.push("protected review fixture minimum not met");
	}
	if (passCases.length < PROMOTION_MIN_PROTECTED_PASS_FIXTURES) {
		failures.push("protected pass fixture minimum not met");
	}
	if (imageCases.length < PROMOTION_MIN_PROTECTED_IMAGE_FIXTURES) {
		failures.push("protected image fixture minimum not met");
	}
	for (const category of MODERATION_FINDING_CATEGORIES) {
		if (categoryCounts[category]! < PROMOTION_MIN_PROTECTED_FIXTURES_PER_CATEGORY) {
			failures.push(`${category}: protected fixture minimum not met`);
		}
	}
	if (unsafePasses > 0) failures.push("unsafe pass observed in protected evaluation");
	if (unsafePassRateUpperBound95 > PROMOTION_MAX_UNSAFE_PASS_RATE_UPPER_BOUND_95) {
		failures.push("unsafe pass confidence bound exceeds one percent");
	}
	return {
		passed: failures.length === 0,
		failures,
		evidence: {
			protectedFixtures: protectedCases.length,
			protectedReviewFixtures: reviewCases.length,
			protectedPassFixtures: passCases.length,
			protectedImageFixtures: imageCases.length,
			protectedFixturesByCategory: categoryCounts,
			unsafePasses,
			unsafePassRateUpperBound95,
		},
	};
}

export function evaluateAutoPassReadiness(
	metrics: EvalMetrics,
	budgets: EvalBudgets,
): { passed: boolean; failures: readonly string[] } {
	const failures: string[] = [];
	if (metrics.invalidOutputs > budgets.maxInvalidOutputs) {
		failures.push("invalid-output budget exceeded");
	}
	if (metrics.modelErrors > budgets.maxModelErrors) failures.push("model-error budget exceeded");
	if (metrics.coverageFailures > 0) failures.push("required coverage is incomplete");
	if (metrics.invalidUsageRuns > 0) failures.push("live usage is missing or invalid");
	if ((metrics.reviewRateByPartition["benign"] ?? 0) > budgets.maxBenignReviewRate) {
		failures.push("benign review-rate budget exceeded");
	}
	if (metrics.outcomeMismatches > budgets.maxOutcomeMismatches) {
		failures.push("expected-outcome budget exceeded");
	}
	if (metrics.repeatedRunDisagreementRate > budgets.maxRepeatedRunDisagreementRate) {
		failures.push("repeated-run disagreement budget exceeded");
	}
	if (metrics.latencyMs.p95 > budgets.maxP95LatencyMs) failures.push("latency budget exceeded");
	if (metrics.usage.configuredUnits > budgets.maxConfiguredUnits) {
		failures.push("usage budget exceeded");
	}
	return { passed: failures.length === 0, failures };
}

export function renderEvalReport(bundle: EvalResultBundle, budgets?: EvalBudgets): string {
	const failures = bundle.budgetEvaluation.failures.map((failure) => `- ${failure}`).join("\n");
	const readiness = budgets ? evaluateAutoPassReadiness(bundle.metrics, budgets) : undefined;
	const readinessFailures = readiness?.failures.map((failure) => `- ${failure}`).join("\n");
	const confidence = evaluatePromotionConfidence(bundle);
	const confidenceFailures = confidence.failures.map((failure) => `- ${failure}`).join("\n");
	return [
		`# Listing metadata AI evaluation`,
		``,
		`Mode: ${bundle.mode}`,
		`Dataset: ${bundle.reproducibility.datasetVersion} (${bundle.reproducibility.datasetHash})`,
		`Cases: ${bundle.cases.length}; repeats: ${bundle.repeatCount}`,
		`Budget result: ${bundle.budgetEvaluation.passed ? "pass" : "fail"}`,
		...(readiness ? [`Automatic-pass readiness: ${readiness.passed ? "pass" : "fail"}`] : []),
		`Invalid outputs: ${bundle.metrics.invalidOutputs}; model errors: ${bundle.metrics.modelErrors}`,
		`Expected-outcome mismatches: ${bundle.metrics.outcomeMismatches}`,
		`P95 latency: ${bundle.metrics.latencyMs.p95}ms; configured usage units: ${bundle.metrics.usage.configuredUnits}`,
		`Promotion confidence: ${confidence.passed ? "pass" : "fail"}`,
		`Protected fixtures: ${confidence.evidence.protectedFixtures} (${confidence.evidence.protectedReviewFixtures} review, ${confidence.evidence.protectedPassFixtures} pass, ${confidence.evidence.protectedImageFixtures} image)`,
		`Observed unsafe passes: ${confidence.evidence.unsafePasses}; one-sided 95% upper bound: ${confidence.evidence.unsafePassRateUpperBound95}`,
		...(failures ? ["", "## Budget failures", "", failures] : []),
		...(readinessFailures
			? ["", "## Automatic-pass readiness failures", "", readinessFailures]
			: []),
		...(confidenceFailures ? ["", "## Promotion confidence failures", "", confidenceFailures] : []),
		"",
	].join("\n");
}

export async function createPromotionManifest(input: {
	dataset: SealedEvalDataset;
	baseline: EvalResultBundle;
	candidate: LiveEvaluationArtifact;
	review: AuthorizedPromotionReview;
	now: Date;
}): Promise<AuthenticatedModelPromotion> {
	const prepared = await preparePromotion(input);
	consumeAuthorizedPromotionReview(input.review, {
		challengeHash: prepared.challengeHash,
		now: input.now,
	});
	return {
		schemaVersion: 1,
		status: "approved",
		policyVersion: prepared.candidate.reproducibility.policyVersion,
		datasetHash: input.dataset.datasetHash,
		reportHash: prepared.comparison.candidateHash,
		baselineHash: prepared.comparison.baselineHash,
		candidateHash: prepared.comparison.candidateHash,
		comparisonHash: prepared.comparison.comparisonHash,
		reviewedAt: input.review.authenticatedAt,
		reviewedBy: input.review.reviewerDid,
		authorization: input.review.authority,
		text: prepared.candidate.reproducibility.text,
		image: prepared.candidate.reproducibility.image,
	};
}

export function consumeAuthorizedPromotionReview(
	review: AuthorizedPromotionReview,
	input: { challengeHash: string; now: Date },
): void {
	assertAuthorizedPromotionReview(review);
	const now = input.now.getTime();
	if (Number.isNaN(now)) throw new TypeError("promotion commit time is invalid");
	if (review.challengeHash !== input.challengeHash) {
		throw new Error("promotion review is not bound to this evaluation artifact");
	}
	if (Date.parse(review.authenticatedAt) > now) {
		throw new Error("promotion review authorization is not yet valid");
	}
	if (Date.parse(review.expiresAt) <= now) {
		throw new Error("promotion review authorization expired before commit");
	}
	if (consumedReviews.has(review)) {
		throw new Error("promotion review authorization was already used");
	}
	consumedReviews.add(review);
}

async function preparePromotion(input: {
	dataset: SealedEvalDataset;
	baseline: EvalResultBundle;
	candidate: LiveEvaluationArtifact;
}): Promise<{
	candidate: EvalResultBundle;
	comparison: EvalComparison;
	challengeHash: string;
}> {
	assertPromotionDatasetComplete(input.dataset);
	assertLiveEvaluationArtifact(input.candidate);
	const candidate = input.candidate.bundle;
	assertEvalBundleIntegrity(input.baseline, input.dataset);
	const verifiedCandidate = assertEvalBundleIntegrity(candidate, input.dataset);
	if (candidate.mode !== "live") {
		throw new Error("candidate is not a live Workers AI evaluation");
	}
	if (candidate.reproducibility.runnerVersion !== EVAL_RUNNER_VERSION) {
		throw new Error("candidate was not produced by the current evaluation runner");
	}
	const readiness = evaluateAutoPassReadiness(verifiedCandidate.metrics, input.dataset.budgets);
	if (!readiness.passed) {
		throw new Error(
			`evaluation is not safe for automatic passing: ${readiness.failures.join(", ")}`,
		);
	}
	const confidence = evaluatePromotionConfidence(candidate);
	if (!confidence.passed) {
		throw new Error(`evaluation confidence is insufficient: ${confidence.failures.join(", ")}`);
	}
	const comparison = await compareEvalBundles(input.baseline, candidate);
	return {
		candidate,
		comparison,
		challengeHash: await promotionReviewChallengeHash(input.dataset, comparison),
	};
}

function assertPromotionDatasetComplete(dataset: SealedEvalDataset): void {
	assertSealedEvalDataset(dataset);
	if (
		!dataset.promotionComplete ||
		!PROMOTION_REQUIRED_PARTITIONS.every((partition) => dataset.partitions.includes(partition))
	) {
		throw new Error("promotion requires the complete partition set, including protected holdout");
	}
}

export async function promotionReviewChallengeHash(
	dataset: SealedEvalDataset,
	comparison: EvalComparison,
): Promise<string> {
	assertSealedEvalDataset(dataset);
	if (comparison.datasetHash !== dataset.datasetHash) {
		throw new Error("promotion comparison does not match the sealed dataset");
	}
	return await sha256Hex(
		stableJson({
			schemaVersion: 1,
			datasetHash: dataset.datasetHash,
			baselineHash: comparison.baselineHash,
			candidateHash: comparison.candidateHash,
			comparisonHash: comparison.comparisonHash,
		}),
	);
}

export function hashBundle(bundle: EvalResultBundle): Promise<string> {
	return sha256Hex(stableJson(bundle));
}

export function assertEvalBundleIntegrity(
	bundle: EvalResultBundle,
	dataset: SealedEvalDataset,
): {
	metrics: EvalResultBundle["metrics"];
	budgetEvaluation: EvalResultBundle["budgetEvaluation"];
} {
	assertSealedEvalDataset(dataset);
	if (
		bundle.schemaVersion !== 1 ||
		(bundle.mode !== "recorded" && bundle.mode !== "live") ||
		bundle.reproducibility.datasetHash !== dataset.datasetHash ||
		bundle.reproducibility.datasetVersion !== dataset.datasetVersion ||
		!Number.isInteger(bundle.repeatCount) ||
		bundle.repeatCount < 1
	) {
		throw new Error("evaluation bundle schema or dataset identity is invalid");
	}
	assertExactFixtureIds(dataset.fixtures, bundle.cases);
	const fixtures = new Map(dataset.fixtures.map((fixture) => [fixture.id, fixture]));
	for (const result of bundle.cases) {
		const fixture = fixtures.get(result.id)!;
		if (
			result.kind !== fixture.kind ||
			result.partition !== fixture.partition ||
			stableJson(result.expected) !== stableJson(fixture.expected) ||
			result.runs.length !== bundle.repeatCount
		) {
			throw new Error(`evaluation case does not match sealed fixture: ${result.id}`);
		}
		for (const run of result.runs) {
			if (
				(run.status !== "complete" &&
					run.status !== "invalid-output" &&
					run.status !== "model-error") ||
				(run.actualOutcome !== "pass" &&
					run.actualOutcome !== "review" &&
					run.actualOutcome !== "error") ||
				!Array.isArray(run.findings) ||
				!Array.isArray(run.actualCategories) ||
				!Array.isArray(run.coveredEvidenceRefs) ||
				typeof run.latencyMs !== "number" ||
				!Number.isFinite(run.latencyMs) ||
				run.latencyMs < 0 ||
				typeof run.usage !== "object" ||
				run.usage === null
			) {
				throw new Error(`evaluation run schema is invalid: ${result.id}`);
			}
		}
	}
	const recomputedMetrics = calculateEvalMetrics(bundle.cases);
	if (stableJson(recomputedMetrics) !== stableJson(bundle.metrics)) {
		throw new Error("evaluation metrics do not match recomputed case metrics");
	}
	const recomputedBudget = evaluateBudgets(recomputedMetrics, dataset.budgets, {
		requireCompleteUsage: bundle.mode === "live",
	});
	if (stableJson(recomputedBudget) !== stableJson(bundle.budgetEvaluation)) {
		throw new Error("evaluation budget result does not match recomputed metrics");
	}
	return { metrics: recomputedMetrics, budgetEvaluation: recomputedBudget };
}

function assertExactFixtureIds(
	baseline: readonly { id: string }[],
	candidate: readonly { id: string }[],
): void {
	const baselineIds = baseline.map(({ id }) => id);
	const candidateIds = candidate.map(({ id }) => id);
	const candidateIdSet = new Set(candidateIds);
	if (
		new Set(baselineIds).size !== baselineIds.length ||
		candidateIdSet.size !== candidateIds.length ||
		baselineIds.length !== candidateIds.length ||
		baselineIds.some((id) => !candidateIdSet.has(id))
	) {
		throw new Error("baseline and candidate fixture IDs must match exactly");
	}
}

function assertAuthorizedPromotionReview(
	value: unknown,
): asserts value is AuthorizedPromotionReview {
	if (typeof value !== "object" || value === null || !authorizedReviews.has(value)) {
		throw new TypeError("promotion review must be authenticated and allowlisted");
	}
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value)
			.toSorted(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
