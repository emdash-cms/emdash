import { loadEvalDataset } from "./dataset.js";
import { runProtectedLiveEvaluation } from "./live.js";
import {
	assertEvalBundleIntegrity,
	compareEvalBundles,
	hashBundle,
	promotionReviewChallengeHash,
	renderEvalReport,
} from "./report.js";
import type { EvalComparison, EvalResultBundle, SealedEvalDataset } from "./types.js";

const MAX_RESULT_BYTES = 64 * 1024;
const MAX_COMPARISON_BYTES = 256 * 1024;
const MAX_REPORT_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const FAILURE_CODE = "EVALUATION_FAILED";
const FAILURE_SUMMARY = "Protected live evaluation could not be completed";
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;

export interface EvalRunInput {
	actorDid: string;
	role: "admin";
	reason: string;
	idempotencyKey: string;
	now: Date;
}

export interface PromotionComparison extends EvalComparison {
	baselineRunId: number;
	reviewChallengeHash: string;
}

export interface CompletedEvalRun {
	artifactKey: string;
	datasetHash: string;
	budgetPassed: boolean;
	failures: readonly string[];
	candidateHash: string;
	promotionComparison: PromotionComparison | null;
	report: string;
}

export interface EvalRunResponse extends CompletedEvalRun {
	runId: number;
}

export interface EvalRunRecord extends EvalRunInput {
	id: number;
	status: "running" | "succeeded" | "failed";
	createdAt: string;
	completed?: CompletedEvalRun;
	failureCode?: string;
	failureSummary?: string;
}

export interface EvalRunStore {
	claim(input: EvalRunInput): Promise<{ inserted: boolean; record: EvalRunRecord }>;
	complete(id: number, completed: CompletedEvalRun, now: Date): Promise<void>;
	fail(id: number, code: string, summary: string, now: Date): Promise<void>;
}

export class EvalRunInProgressError extends Error {
	override readonly name = "EvalRunInProgressError";
	readonly code = "EVALUATION_RUNNING";
}

export class EvalRunFailedError extends Error {
	override readonly name = "EvalRunFailedError";
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export async function runProductionLiveEvaluation(
	env: Env,
	input: EvalRunInput,
): Promise<EvalRunResponse> {
	return runIdempotentLiveEvaluation({
		store: createD1EvalRunStore(env.DB),
		input,
		execute: (runId) => executeProductionLiveEvaluation(env, runId),
	});
}

export async function runIdempotentLiveEvaluation(input: {
	store: EvalRunStore;
	input: EvalRunInput;
	execute(runId: number): Promise<CompletedEvalRun>;
}): Promise<EvalRunResponse> {
	validateEvalRunInput(input.input);
	const claim = await input.store.claim(input.input);
	if (!sameEvalRequest(claim.record, input.input)) {
		throw new TypeError("idempotency key is bound to a different evaluation request");
	}
	if (!claim.inserted) return replayEvalRun(claim.record);

	try {
		const completed = await input.execute(claim.record.id);
		validateCompletedEvalRun(completed);
		await input.store.complete(claim.record.id, completed, new Date());
		return { runId: claim.record.id, ...completed };
	} catch (error) {
		console.error(
			JSON.stringify({
				message: "protected live evaluation failed",
				runId: claim.record.id,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		await input.store.fail(claim.record.id, FAILURE_CODE, FAILURE_SUMMARY, new Date());
		throw new EvalRunFailedError(FAILURE_CODE, FAILURE_SUMMARY);
	}
}

export function createD1EvalRunStore(db: D1Database): EvalRunStore {
	return {
		async claim(input) {
			const createdAt = input.now.toISOString();
			const inserted = await db
				.prepare(
					`INSERT INTO eval_runs
					   (idempotency_key, actor_did, actor_role, reason, status, created_at, updated_at)
					 VALUES (?, ?, ?, ?, 'running', ?, ?)
					 ON CONFLICT(idempotency_key) DO NOTHING`,
				)
				.bind(input.idempotencyKey, input.actorDid, input.role, input.reason, createdAt, createdAt)
				.run();
			const record = await readEvalRun(db, input.idempotencyKey);
			if (!record) throw new Error("evaluation run claim could not be read");
			return { inserted: inserted.meta.changes === 1, record };
		},
		async complete(id, completed, now) {
			const resultJson = JSON.stringify({
				artifactKey: completed.artifactKey,
				datasetHash: completed.datasetHash,
				budgetPassed: completed.budgetPassed,
				failures: completed.failures,
				candidateHash: completed.candidateHash,
			});
			const comparisonJson = completed.promotionComparison
				? JSON.stringify(completed.promotionComparison)
				: null;
			assertBoundedText(resultJson, MAX_RESULT_BYTES, "evaluation result");
			if (comparisonJson) {
				assertBoundedText(comparisonJson, MAX_COMPARISON_BYTES, "evaluation comparison");
			}
			assertBoundedText(completed.report, MAX_REPORT_BYTES, "evaluation report");
			const comparison = completed.promotionComparison;
			const timestamp = now.toISOString();
			const updated = await db
				.prepare(
					`UPDATE eval_runs
					 SET status = 'succeeded', artifact_key = ?, dataset_hash = ?, budget_passed = ?,
					     candidate_hash = ?, baseline_run_id = ?, baseline_hash = ?,
					     comparison_hash = ?, promotion_challenge_hash = ?, result_json = ?,
					     comparison_json = ?, report_markdown = ?, updated_at = ?, completed_at = ?
					 WHERE id = ? AND status = 'running'`,
				)
				.bind(
					completed.artifactKey,
					completed.datasetHash,
					completed.budgetPassed ? 1 : 0,
					completed.candidateHash,
					comparison?.baselineRunId ?? null,
					comparison?.baselineHash ?? null,
					comparison?.comparisonHash ?? null,
					comparison?.reviewChallengeHash ?? null,
					resultJson,
					comparisonJson,
					completed.report,
					timestamp,
					timestamp,
					id,
				)
				.run();
			if (updated.meta.changes !== 1) {
				throw new Error("evaluation run completion conflicted");
			}
		},
		async fail(id, code, summary, now) {
			const timestamp = now.toISOString();
			await db
				.prepare(
					`UPDATE eval_runs
					 SET status = 'failed', failure_code = ?, failure_summary = ?,
					     updated_at = ?, completed_at = ?
					 WHERE id = ? AND status = 'running'`,
				)
				.bind(code, summary, timestamp, timestamp, id)
				.run();
		},
	};
}

async function executeProductionLiveEvaluation(env: Env, runId: number): Promise<CompletedEvalRun> {
	const holdout = await env.EVAL_DATASETS.get("protected/holdout.json");
	if (!holdout) throw new Error("protected evaluation holdout is not configured");
	const dataset = await loadEvalDataset({
		readFile: async (path) => {
			const object = await env.EVAL_DATASETS.get(`v1/${path}`);
			if (!object) throw new Error(`evaluation dataset object is missing: ${path}`);
			return object.bytes();
		},
		protectedHoldout: { fixtureBytes: await holdout.bytes() },
	});
	const baseline = await readLatestBaseline(env, dataset, runId);
	const artifact = await runProtectedLiveEvaluation({
		dataset,
		text: {
			modelId: env.LABELER_TEXT_MODEL_ID,
			promptHash: env.LABELER_TEXT_PROMPT_HASH,
			configuredUnits: parseUnits(env.EVAL_TEXT_CONFIGURED_UNITS, "text"),
		},
		image: {
			modelId: env.LABELER_IMAGE_MODEL_ID,
			promptHash: env.LABELER_IMAGE_PROMPT_HASH,
			configuredUnits: parseUnits(env.EVAL_IMAGE_CONFIGURED_UNITS, "image"),
		},
		repeatCount: 3,
		runnerCommit: env.VERSION_METADATA.id,
	});
	const candidate = artifact.bundle;
	const candidateHash = await hashBundle(candidate);
	let promotionComparison: PromotionComparison | null = null;
	if (baseline) {
		const comparison = await compareEvalBundles(baseline.bundle, candidate);
		promotionComparison = {
			baselineRunId: baseline.runId,
			...comparison,
			reviewChallengeHash: await promotionReviewChallengeHash(dataset, comparison),
		};
	}
	const report = renderEvalReport(candidate);
	const encoded = JSON.stringify(candidate);
	assertBoundedText(encoded, MAX_ARTIFACT_BYTES, "evaluation artifact");
	const artifactKey = `live/${candidate.reproducibility.executedAt}/${candidateHash}.json`;
	await env.EVAL_ARTIFACTS.put(artifactKey, encoded, {
		httpMetadata: { contentType: "application/json" },
		customMetadata: {
			datasetHash: dataset.datasetHash,
			runnerCommit: env.VERSION_METADATA.id,
			candidateHash,
		},
	});
	return {
		artifactKey,
		datasetHash: dataset.datasetHash,
		budgetPassed: candidate.budgetEvaluation.passed,
		failures: candidate.budgetEvaluation.failures,
		candidateHash,
		promotionComparison,
		report,
	};
}

async function readLatestBaseline(
	env: Env,
	dataset: SealedEvalDataset,
	currentRunId: number,
): Promise<{ runId: number; bundle: EvalResultBundle } | null> {
	const row = await env.DB.prepare(
		`SELECT id, artifact_key, candidate_hash
		 FROM eval_runs
		 WHERE status = 'succeeded' AND dataset_hash = ? AND id <> ?
		 ORDER BY completed_at DESC, id DESC
		 LIMIT 1`,
	)
		.bind(dataset.datasetHash, currentRunId)
		.first<{ id: number; artifact_key: string; candidate_hash: string }>();
	if (!row) return null;
	const object = await env.EVAL_ARTIFACTS.get(row.artifact_key);
	if (!object) throw new Error("evaluation baseline artifact is missing");
	if (object.size > MAX_ARTIFACT_BYTES)
		throw new Error("evaluation baseline artifact is too large");
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await object.bytes()),
		);
	} catch {
		throw new Error("evaluation baseline artifact is invalid");
	}
	const bundle = evalResultBundle(parsed);
	assertEvalBundleIntegrity(bundle, dataset);
	if (bundle.mode !== "live" || (await hashBundle(bundle)) !== row.candidate_hash) {
		throw new Error("evaluation baseline artifact identity does not match its run");
	}
	return { runId: row.id, bundle };
}

async function readEvalRun(db: D1Database, idempotencyKey: string): Promise<EvalRunRecord | null> {
	const row = await db
		.prepare(
			`SELECT id, idempotency_key, actor_did, actor_role, reason, status, result_json,
			        comparison_json, report_markdown, failure_code, failure_summary, created_at
			 FROM eval_runs WHERE idempotency_key = ?`,
		)
		.bind(idempotencyKey)
		.first<{
			id: number;
			idempotency_key: string;
			actor_did: string;
			actor_role: "admin";
			reason: string;
			status: "running" | "succeeded" | "failed";
			result_json: string | null;
			comparison_json: string | null;
			report_markdown: string | null;
			failure_code: string | null;
			failure_summary: string | null;
			created_at: string;
		}>();
	if (!row) return null;
	let completed: CompletedEvalRun | undefined;
	if (row.status === "succeeded") {
		if (!row.result_json || !row.report_markdown) {
			throw new Error("stored evaluation result is incomplete");
		}
		const result = parseStoredResult(row.result_json);
		completed = {
			...result,
			promotionComparison: row.comparison_json ? parseStoredComparison(row.comparison_json) : null,
			report: row.report_markdown,
		};
		validateCompletedEvalRun(completed);
	}
	return {
		id: row.id,
		idempotencyKey: row.idempotency_key,
		actorDid: row.actor_did,
		role: row.actor_role,
		reason: row.reason,
		now: new Date(row.created_at),
		status: row.status,
		createdAt: row.created_at,
		...(completed ? { completed } : {}),
		...(row.failure_code ? { failureCode: row.failure_code } : {}),
		...(row.failure_summary ? { failureSummary: row.failure_summary } : {}),
	};
}

function replayEvalRun(record: EvalRunRecord): EvalRunResponse {
	if (record.status === "running") {
		throw new EvalRunInProgressError("Evaluation is already running for this idempotency key");
	}
	if (record.status === "failed") {
		throw new EvalRunFailedError(
			record.failureCode ?? FAILURE_CODE,
			record.failureSummary ?? FAILURE_SUMMARY,
		);
	}
	if (!record.completed) throw new Error("stored evaluation result is incomplete");
	return { runId: record.id, ...record.completed };
}

function parseStoredResult(
	value: string,
): Omit<CompletedEvalRun, "promotionComparison" | "report"> {
	const parsed = parseObject(value, "stored evaluation result");
	if (
		typeof parsed["artifactKey"] !== "string" ||
		typeof parsed["datasetHash"] !== "string" ||
		typeof parsed["budgetPassed"] !== "boolean" ||
		!Array.isArray(parsed["failures"]) ||
		!parsed["failures"].every((failure) => typeof failure === "string") ||
		typeof parsed["candidateHash"] !== "string"
	) {
		throw new Error("stored evaluation result is invalid");
	}
	return {
		artifactKey: parsed["artifactKey"],
		datasetHash: parsed["datasetHash"],
		budgetPassed: parsed["budgetPassed"],
		failures: parsed["failures"],
		candidateHash: parsed["candidateHash"],
	};
}

function parseStoredComparison(value: string): PromotionComparison {
	const comparison: unknown = parseObject(value, "stored evaluation comparison");
	validatePromotionComparison(comparison);
	return comparison;
}

function parseObject(value: string, name: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(`${name} is invalid`);
	}
	const record = unknownRecord(parsed);
	if (!record) throw new Error(`${name} is invalid`);
	return record;
}

function evalResultBundle(value: unknown): EvalResultBundle {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("evaluation baseline artifact is invalid");
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- assertEvalBundleIntegrity validates every field before the value is used
	return value as EvalResultBundle;
}

function validateEvalRunInput(input: EvalRunInput): void {
	if (
		input.role !== "admin" ||
		input.actorDid.length < 1 ||
		input.actorDid.length > 500 ||
		input.reason.trim().length < 1 ||
		input.reason.length > 1_000 ||
		!IDEMPOTENCY_KEY_RE.test(input.idempotencyKey) ||
		Number.isNaN(input.now.getTime())
	) {
		throw new TypeError("evaluation run input is invalid");
	}
}

function validateCompletedEvalRun(completed: CompletedEvalRun): void {
	if (
		completed.artifactKey.length < 1 ||
		completed.artifactKey.length > 1_024 ||
		!SHA256_HEX_RE.test(completed.datasetHash) ||
		!SHA256_HEX_RE.test(completed.candidateHash) ||
		!Array.isArray(completed.failures) ||
		!completed.failures.every((failure) => typeof failure === "string")
	) {
		throw new TypeError("completed evaluation result is invalid");
	}
	if (completed.promotionComparison) {
		validatePromotionComparison(completed.promotionComparison);
		if (
			completed.promotionComparison.datasetHash !== completed.datasetHash ||
			completed.promotionComparison.candidateHash !== completed.candidateHash
		) {
			throw new TypeError("completed evaluation comparison is invalid");
		}
	}
}

function validatePromotionComparison(
	comparison: unknown,
): asserts comparison is PromotionComparison {
	if (typeof comparison !== "object" || comparison === null || Array.isArray(comparison)) {
		throw new TypeError("completed evaluation comparison is invalid");
	}
	const value = unknownRecord(comparison);
	if (!value) throw new TypeError("completed evaluation comparison is invalid");
	const metricDelta = value["metricDelta"];
	const metricDeltaRecord = unknownRecord(metricDelta);
	const changedCases = value["changedCases"];
	const baselineRunId = value["baselineRunId"];
	const requiredMetrics = [
		"invalidOutputs",
		"modelErrors",
		"repeatedRunDisagreements",
		"p95LatencyMs",
		"configuredUnits",
	] as const;
	if (
		value["schemaVersion"] !== 1 ||
		typeof baselineRunId !== "number" ||
		!Number.isSafeInteger(baselineRunId) ||
		baselineRunId < 1 ||
		typeof value["datasetHash"] !== "string" ||
		!SHA256_HEX_RE.test(value["datasetHash"]) ||
		typeof value["baselineHash"] !== "string" ||
		!SHA256_HEX_RE.test(value["baselineHash"]) ||
		typeof value["candidateHash"] !== "string" ||
		!SHA256_HEX_RE.test(value["candidateHash"]) ||
		typeof value["comparisonHash"] !== "string" ||
		!SHA256_HEX_RE.test(value["comparisonHash"]) ||
		typeof value["reviewChallengeHash"] !== "string" ||
		!SHA256_HEX_RE.test(value["reviewChallengeHash"]) ||
		!Array.isArray(changedCases) ||
		!changedCases.every(isStoredChangedCase) ||
		!metricDeltaRecord ||
		!requiredMetrics.every(
			(key) =>
				typeof metricDeltaRecord[key] === "number" && Number.isFinite(metricDeltaRecord[key]),
		)
	) {
		throw new TypeError("completed evaluation comparison is invalid");
	}
}

function isStoredChangedCase(value: unknown): boolean {
	const item = unknownRecord(value);
	if (!item) return false;
	return (
		typeof item["id"] === "string" &&
		Array.isArray(item["baselineCategories"]) &&
		item["baselineCategories"].every((category) => typeof category === "string") &&
		Array.isArray(item["candidateCategories"]) &&
		item["candidateCategories"].every((category) => typeof category === "string") &&
		isEvalOutcome(item["baselineOutcome"]) &&
		isEvalOutcome(item["candidateOutcome"])
	);
}

function unknownRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return Object.fromEntries(
		Object.keys(value).map((key) => [key, Object.getOwnPropertyDescriptor(value, key)?.value]),
	);
}

function isEvalOutcome(value: unknown): boolean {
	return value === "pass" || value === "review" || value === "error";
}

function sameEvalRequest(record: EvalRunRecord, input: EvalRunInput): boolean {
	return (
		record.actorDid === input.actorDid &&
		record.role === input.role &&
		record.reason === input.reason &&
		record.idempotencyKey === input.idempotencyKey
	);
}

function assertBoundedText(value: string, maxBytes: number, name: string): void {
	if (new TextEncoder().encode(value).byteLength > maxBytes) {
		throw new RangeError(`${name} exceeds its storage budget`);
	}
}

function parseUnits(value: string, purpose: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new TypeError(`${purpose} evaluation usage configuration is invalid`);
	}
	return parsed;
}
