import type {
	ModerationFindingCategory,
	NormalizedModerationFinding,
} from "@emdash-cms/registry-moderation";

import type { ModerationModelIdentity, ModerationUsage } from "../src/ai/types.js";

export type EvalPartition =
	| "gold-prohibited"
	| "benign"
	| "borderline"
	| "prompt-injection"
	| "unicode-confusable"
	| "multilingual"
	| "long-input"
	| "image-clean"
	| "image-prohibited"
	| "holdout"
	| "redacted-shadow";

export interface TextEvalFixture {
	id: string;
	kind: "text";
	partition: EvalPartition;
	input: {
		text: readonly { ref: string; value: string; format: "plain" | "markdown" }[];
		links: readonly {
			ref: string;
			url: string;
			usage: "author" | "security" | "repository" | "sbom" | "markdown";
		}[];
	};
	expected: EvalExpectation;
}

export interface ImageEvalFixture {
	id: string;
	kind: "image";
	partition: EvalPartition;
	input: { assetId: string; evidenceRef: string; mimeType: "image/png" };
	expected: EvalExpectation;
}

export type EvalFixture = TextEvalFixture | ImageEvalFixture;

export interface EvalExpectation {
	categories: readonly ModerationFindingCategory[];
	outcome: "pass" | "review";
}

export interface EvalDataset {
	schemaVersion: 1;
	datasetVersion: string;
	datasetHash: string;
	fixtures: readonly EvalFixture[];
	assets: Readonly<Record<string, string>>;
	budgets: EvalBudgets;
	holdoutCommitment: string;
	partitions: readonly EvalPartition[];
	promotionComplete: boolean;
}

export const sealedEvalDatasetBrand: unique symbol = Symbol("sealedEvalDataset");

export interface SealedEvalDataset extends EvalDataset {
	readonly [sealedEvalDatasetBrand]: true;
}

export interface EvalBudgets {
	maxFalseNegativesPerCategory: number;
	maxFalsePositivesPerCategory: number;
	maxInvalidOutputs: number;
	maxModelErrors: number;
	maxBenignReviewRate: number;
	maxOutcomeMismatches: number;
	maxRepeatedRunDisagreementRate: number;
	maxP95LatencyMs: number;
	maxConfiguredUnits: number;
}

export interface EvalRecording {
	output: unknown;
	latencyMs: number;
	usage: ModerationUsage;
}

export interface EvalCaseRun {
	status: "complete" | "invalid-output" | "model-error";
	findings: readonly NormalizedModerationFinding[];
	actualCategories: readonly ModerationFindingCategory[];
	actualOutcome: "pass" | "review" | "error";
	coveredEvidenceRefs: readonly string[];
	latencyMs: number;
	usage: ModerationUsage;
	errorCode?: string;
}

export interface EvalCaseResult {
	id: string;
	kind: EvalFixture["kind"];
	partition: EvalPartition;
	expected: EvalExpectation;
	runs: readonly EvalCaseRun[];
	disagreed: boolean;
}

export interface CategoryMetrics {
	truePositive: number;
	trueNegative: number;
	falsePositive: number;
	falseNegative: number;
}

export interface EvalMetrics {
	categories: Readonly<Record<ModerationFindingCategory, CategoryMetrics>>;
	reviewRateByPartition: Readonly<Record<string, number>>;
	invalidOutputs: number;
	missingEvidence: number;
	contradictoryOutputs: number;
	modelErrors: number;
	coverageFailures: number;
	invalidUsageRuns: number;
	outcomeMismatches: number;
	repeatedRunDisagreements: number;
	repeatedRunDisagreementRate: number;
	latencyMs: { p50: number; p95: number; max: number };
	usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		configuredUnits: number;
	};
	operatorDisagreements: number | null;
	operatorOverrides: number | null;
}

export interface EvalReproducibility {
	datasetVersion: string;
	datasetHash: string;
	policyVersion: string;
	canonicalInputVersion: string;
	runnerVersion: string;
	runnerCommit: string;
	executedAt: string;
	text: ModerationModelIdentity;
	image: ModerationModelIdentity;
}

export interface EvalResultBundle {
	schemaVersion: 1;
	mode: "recorded" | "live";
	repeatCount: number;
	reproducibility: EvalReproducibility;
	cases: readonly EvalCaseResult[];
	metrics: EvalMetrics;
	budgetEvaluation: EvalBudgetEvaluation;
}

export interface EvalBudgetEvaluation {
	passed: boolean;
	failures: readonly string[];
}

export interface EvalComparison {
	schemaVersion: 1;
	datasetHash: string;
	baselineHash: string;
	candidateHash: string;
	comparisonHash: string;
	changedCases: readonly {
		id: string;
		baselineCategories: readonly ModerationFindingCategory[];
		candidateCategories: readonly ModerationFindingCategory[];
		baselineOutcome: EvalCaseRun["actualOutcome"];
		candidateOutcome: EvalCaseRun["actualOutcome"];
	}[];
	metricDelta: {
		invalidOutputs: number;
		modelErrors: number;
		outcomeMismatches: number;
		repeatedRunDisagreements: number;
		p95LatencyMs: number;
		configuredUnits: number;
	};
}
