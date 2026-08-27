import type { WorkflowInstanceStatus } from "cloudflare:workers";

import { sha256Hex } from "../src/ai/hash.js";
import { IMAGE_PROMPT_HASH, TEXT_PROMPT_HASH } from "../src/ai/prompts.js";
import { loadEvalDataset } from "./dataset.js";
import { EVAL_RUNNER_VERSION } from "./harness.js";
import { runProtectedLiveEvaluation } from "./live.js";
import type { ProtectedLiveEvaluationDurability } from "./live.js";
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
const MAX_PUBLIC_DATASET_OBJECT_BYTES = 8 * 1024 * 1024;
const MAX_PROTECTED_HOLDOUT_BYTES = 2 * 1024 * 1024;
const FAILURE_CODE = "EVALUATION_FAILED";
const FAILURE_SUMMARY = "Protected live evaluation could not be completed";
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;
const EVAL_RUN_LEASE_MS = 5 * 60 * 1_000;
const EVAL_RUN_HEARTBEAT_MS = 30 * 1_000;
const PRODUCTION_READ_RETRY_DELAYS_MS = [250, 1_000] as const;

export interface EvalRunInput {
	actorDid: string;
	role: "admin";
	reason: string;
	idempotencyKey: string;
	now: Date;
}

export interface EvalR2Object {
	readonly size: number;
	bytes(): Promise<Uint8Array>;
}

export interface ProductionLiveEvaluationDurability extends ProtectedLiveEvaluationDurability {
	executedAt: string;
	identity: ProductionEvaluationIdentity;
	selectBaseline(
		callback: () => Promise<EvalBaselineReference | null>,
	): Promise<EvalBaselineReference | null>;
	storeArtifact(callback: () => Promise<void>): Promise<void>;
}

export interface ProductionEvaluationIdentity {
	schemaVersion: 1;
	datasetVersion: string;
	datasetHash: string;
	budgetHash: string;
	runnerVersion: string;
	runnerCommit: string;
	repeatCount: 3;
	textModelId: string;
	textPromptHash: string;
	imageModelId: string;
	imagePromptHash: string;
}

export interface EvalBaselineReference {
	runId: number;
	artifactKey: string;
	candidateHash: string;
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
	leaseToken?: string;
	leaseExpiresAt?: string;
	workflowInstanceId?: string;
}

export interface LiveEvaluationWorkflowParams {
	schemaVersion: 1;
	runId: number;
	idempotencyKey: string;
	instanceId: string;
	executedAt: string;
}

export interface EvalWorkflowBinding {
	create(input: { id: string; params: LiveEvaluationWorkflowParams }): Promise<unknown>;
	get(id: string): Promise<{
		status(): Promise<{ status: WorkflowInstanceStatus }>;
	}>;
}

export type EvalRunStatusResponse =
	| { runId: number; instanceId: string; status: "running" }
	| { runId: number; instanceId: string; status: "succeeded"; result: CompletedEvalRun }
	| {
			runId: number;
			instanceId: string;
			status: "failed";
			failure: { code: string; summary: string };
	  };

export interface EvalRunStore {
	claim(
		input: EvalRunInput,
	): Promise<{ inserted: boolean; leaseToken: string; record: EvalRunRecord }>;
	renew(id: number, leaseToken: string, now: Date): Promise<boolean>;
	complete(
		id: number,
		leaseToken: string,
		completed: CompletedEvalRun,
		now: Date,
	): Promise<boolean>;
	fail(id: number, leaseToken: string, code: string, summary: string, now: Date): Promise<boolean>;
	readById(id: number): Promise<EvalRunRecord | null>;
	readByIdempotencyKey(idempotencyKey: string): Promise<EvalRunRecord | null>;
	bindWorkflow(id: number, leaseToken: string, instanceId: string): Promise<boolean>;
	completeWorkflow(
		id: number,
		instanceId: string,
		completed: CompletedEvalRun,
		now: Date,
	): Promise<boolean>;
	failWorkflow(
		id: number,
		instanceId: string,
		code: string,
		summary: string,
		now: Date,
	): Promise<boolean>;
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

export function startProductionLiveEvaluation(
	env: Env,
	input: EvalRunInput,
): Promise<EvalRunStatusResponse> {
	return startIdempotentLiveEvaluation({
		store: createD1EvalRunStore(env.DB),
		workflow: env.LIVE_EVALUATION_WORKFLOW,
		input,
	});
}

export async function startIdempotentLiveEvaluation(input: {
	store: EvalRunStore;
	workflow: EvalWorkflowBinding;
	input: EvalRunInput;
}): Promise<EvalRunStatusResponse> {
	validateEvalRunInput(input.input);
	const existing = await input.store.readByIdempotencyKey(input.input.idempotencyKey);
	if (existing) {
		if (!sameEvalRequest(existing, input.input)) {
			throw new TypeError("idempotency key is bound to a different evaluation request");
		}
		if (existing.status !== "running") return evalRunStatus(existing);
		if (existing.workflowInstanceId) {
			return evalRunStatus(await ensureWorkflowInstance(input.workflow, input.store, existing));
		}
	}

	const claim = await input.store.claim(input.input);
	if (!sameEvalRequest(claim.record, input.input)) {
		throw new TypeError("idempotency key is bound to a different evaluation request");
	}
	if (claim.record.status !== "running") return evalRunStatus(claim.record);
	const instanceId = `listing-eval-${claim.record.id}`;
	if (claim.record.workflowInstanceId) {
		return evalRunStatus(await ensureWorkflowInstance(input.workflow, input.store, claim.record));
	}
	if (!claim.record.leaseToken) {
		throw new Error("evaluation run has no dispatch lease or Workflow binding");
	}
	if (!(await input.store.bindWorkflow(claim.record.id, claim.record.leaseToken, instanceId))) {
		const current = await input.store.readById(claim.record.id);
		if (!current) throw new Error("evaluation run disappeared before Workflow dispatch");
		return evalRunStatus(
			current.workflowInstanceId
				? await ensureWorkflowInstance(input.workflow, input.store, current)
				: current,
		);
	}
	const bound = await input.store.readById(claim.record.id);
	if (!bound) throw new Error("evaluation run disappeared after Workflow binding");
	return evalRunStatus(await ensureWorkflowInstance(input.workflow, input.store, bound));
}

async function ensureWorkflowInstance(
	workflow: EvalWorkflowBinding,
	store: EvalRunStore,
	record: EvalRunRecord,
): Promise<EvalRunRecord> {
	if (record.status !== "running" || !record.workflowInstanceId) return record;
	const instanceId = record.workflowInstanceId;
	const status = await readWorkflowStatus(workflow, instanceId);
	if (status === "errored" || status === "terminated") {
		await store.failWorkflow(record.id, instanceId, FAILURE_CODE, FAILURE_SUMMARY, new Date());
		const failed = await store.readById(record.id);
		if (!failed) throw new Error("evaluation run disappeared after Workflow failure");
		if (failed.status === "running") {
			throw new Error("evaluation Workflow failure could not be recorded");
		}
		return failed;
	}
	if (status !== "unknown") return record;
	try {
		await workflow.create({
			id: instanceId,
			params: {
				schemaVersion: 1,
				runId: record.id,
				idempotencyKey: record.idempotencyKey,
				instanceId,
				executedAt: record.createdAt,
			},
		});
	} catch (error) {
		const concurrentStatus = await readWorkflowStatus(workflow, instanceId);
		if (concurrentStatus === "unknown") throw error;
	}
	return record;
}

async function readWorkflowStatus(
	workflow: EvalWorkflowBinding,
	instanceId: string,
): Promise<WorkflowInstanceStatus> {
	try {
		return (await (await workflow.get(instanceId)).status()).status;
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("(instance.not_found)")) {
			return "unknown";
		}
		throw error;
	}
}

export async function readEvalRunStatus(
	store: Pick<EvalRunStore, "readById">,
	runId: number,
): Promise<EvalRunStatusResponse | null> {
	if (!Number.isSafeInteger(runId) || runId < 1)
		throw new TypeError("evaluation run ID is invalid");
	const record = await store.readById(runId);
	return record ? evalRunStatus(record) : null;
}

function evalRunStatus(record: EvalRunRecord): EvalRunStatusResponse {
	const instanceId = record.workflowInstanceId ?? `listing-eval-${record.id}`;
	if (record.status === "succeeded") {
		if (!record.completed) throw new Error("stored evaluation result is incomplete");
		return { runId: record.id, instanceId, status: "succeeded", result: record.completed };
	}
	if (record.status === "failed") {
		return {
			runId: record.id,
			instanceId,
			status: "failed",
			failure: {
				code: record.failureCode ?? FAILURE_CODE,
				summary: record.failureSummary ?? FAILURE_SUMMARY,
			},
		};
	}
	return { runId: record.id, instanceId, status: "running" };
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

	const heartbeat = startEvalRunHeartbeat(input.store, claim.record.id, claim.leaseToken);
	try {
		const completed = await input.execute(claim.record.id);
		if (!(await heartbeat.stop())) {
			throw new EvalRunInProgressError("Evaluation lease ownership changed during execution");
		}
		validateCompletedEvalRun(completed);
		if (!(await input.store.complete(claim.record.id, claim.leaseToken, completed, new Date()))) {
			throw new EvalRunInProgressError("Evaluation lease ownership changed before completion");
		}
		return { runId: claim.record.id, ...completed };
	} catch (error) {
		await heartbeat.stop();
		console.error(
			JSON.stringify({
				message: "protected live evaluation failed",
				runId: claim.record.id,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		const failed = await input.store.fail(
			claim.record.id,
			claim.leaseToken,
			FAILURE_CODE,
			FAILURE_SUMMARY,
			new Date(),
		);
		if (!failed) {
			throw new EvalRunInProgressError(
				"Evaluation lease ownership changed during failure handling",
			);
		}
		throw new EvalRunFailedError(FAILURE_CODE, FAILURE_SUMMARY);
	}
}

export function createD1EvalRunStore(db: D1Database): EvalRunStore {
	return {
		async claim(input) {
			const createdAt = input.now.toISOString();
			const leaseToken = crypto.randomUUID();
			const leaseExpiresAt = new Date(input.now.getTime() + EVAL_RUN_LEASE_MS).toISOString();
			const inserted = await db
				.prepare(
					`INSERT INTO eval_runs
					   (idempotency_key, actor_did, actor_role, reason, status, created_at, updated_at,
					    lease_token, lease_expires_at, attempt)
					 VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, 1)
					 ON CONFLICT(idempotency_key) DO UPDATE SET
					   lease_token = excluded.lease_token,
					   lease_expires_at = excluded.lease_expires_at,
					   updated_at = excluded.updated_at,
					   attempt = eval_runs.attempt + 1
					 WHERE eval_runs.status = 'running'
					   AND eval_runs.actor_did = excluded.actor_did
					   AND eval_runs.actor_role = excluded.actor_role
					   AND eval_runs.reason = excluded.reason
					   AND eval_runs.workflow_instance_id IS NULL
					   AND (eval_runs.lease_expires_at IS NULL
					     OR eval_runs.lease_expires_at <= excluded.updated_at)`,
				)
				.bind(
					input.idempotencyKey,
					input.actorDid,
					input.role,
					input.reason,
					createdAt,
					createdAt,
					leaseToken,
					leaseExpiresAt,
				)
				.run();
			const record = await readEvalRun(db, input.idempotencyKey);
			if (!record) throw new Error("evaluation run claim could not be read");
			return {
				inserted: inserted.meta.changes === 1 && record.leaseToken === leaseToken,
				leaseToken,
				record,
			};
		},
		async renew(id, leaseToken, now) {
			const renewed = await db
				.prepare(
					`UPDATE eval_runs SET lease_expires_at = ?, updated_at = ?
					 WHERE id = ? AND status = 'running' AND lease_token = ?`,
				)
				.bind(
					new Date(now.getTime() + EVAL_RUN_LEASE_MS).toISOString(),
					now.toISOString(),
					id,
					leaseToken,
				)
				.run();
			return renewed.meta.changes === 1;
		},
		async complete(id, leaseToken, completed, now) {
			return persistCompletedEvalRun(db, id, "lease_token", leaseToken, completed, now);
		},
		async fail(id, leaseToken, code, summary, now) {
			return persistFailedEvalRun(db, id, "lease_token", leaseToken, code, summary, now);
		},
		readById(id) {
			return readEvalRunById(db, id);
		},
		readByIdempotencyKey(idempotencyKey) {
			return readEvalRun(db, idempotencyKey);
		},
		async bindWorkflow(id, leaseToken, instanceId) {
			const bound = await db
				.prepare(
					`UPDATE eval_runs SET workflow_instance_id = ?, lease_token = NULL,
					   lease_expires_at = NULL, updated_at = updated_at
					 WHERE id = ? AND status = 'running' AND lease_token = ?
					   AND (workflow_instance_id IS NULL OR workflow_instance_id = ?)`,
				)
				.bind(instanceId, id, leaseToken, instanceId)
				.run();
			return bound.meta.changes === 1;
		},
		async completeWorkflow(id, instanceId, completed, now) {
			return persistCompletedEvalRun(db, id, "workflow_instance_id", instanceId, completed, now);
		},
		async failWorkflow(id, instanceId, code, summary, now) {
			return persistFailedEvalRun(db, id, "workflow_instance_id", instanceId, code, summary, now);
		},
	};
}

type EvalRunFence = "lease_token" | "workflow_instance_id";

const COMPLETE_BY_LEASE_SQL = `UPDATE eval_runs
	SET status = 'succeeded', artifact_key = ?, dataset_hash = ?, budget_passed = ?,
	    candidate_hash = ?, baseline_run_id = ?, baseline_hash = ?, comparison_hash = ?,
	    promotion_challenge_hash = ?, result_json = ?, comparison_json = ?, report_markdown = ?,
	    updated_at = ?, completed_at = ?, lease_token = NULL, lease_expires_at = NULL
	WHERE id = ? AND status = 'running' AND lease_token = ?`;

const COMPLETE_BY_WORKFLOW_SQL = `UPDATE eval_runs
	SET status = 'succeeded', artifact_key = ?, dataset_hash = ?, budget_passed = ?,
	    candidate_hash = ?, baseline_run_id = ?, baseline_hash = ?, comparison_hash = ?,
	    promotion_challenge_hash = ?, result_json = ?, comparison_json = ?, report_markdown = ?,
	    updated_at = ?, completed_at = ?, lease_token = NULL, lease_expires_at = NULL
	WHERE id = ? AND status = 'running' AND workflow_instance_id = ?`;

const FAIL_BY_LEASE_SQL = `UPDATE eval_runs
	SET status = 'failed', failure_code = ?, failure_summary = ?, updated_at = ?, completed_at = ?,
	    lease_token = NULL, lease_expires_at = NULL
	WHERE id = ? AND status = 'running' AND lease_token = ?`;

const FAIL_BY_WORKFLOW_SQL = `UPDATE eval_runs
	SET status = 'failed', failure_code = ?, failure_summary = ?, updated_at = ?, completed_at = ?,
	    lease_token = NULL, lease_expires_at = NULL
	WHERE id = ? AND status = 'running' AND workflow_instance_id = ?`;

async function persistCompletedEvalRun(
	db: D1Database,
	id: number,
	fence: EvalRunFence,
	fenceValue: string,
	completed: CompletedEvalRun,
	now: Date,
): Promise<boolean> {
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
	if (comparisonJson)
		assertBoundedText(comparisonJson, MAX_COMPARISON_BYTES, "evaluation comparison");
	assertBoundedText(completed.report, MAX_REPORT_BYTES, "evaluation report");
	const comparison = completed.promotionComparison;
	const timestamp = now.toISOString();
	const statement =
		fence === "lease_token"
			? db.prepare(COMPLETE_BY_LEASE_SQL)
			: db.prepare(COMPLETE_BY_WORKFLOW_SQL);
	const updated = await statement
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
			fenceValue,
		)
		.run();
	return updated.meta.changes === 1;
}

async function persistFailedEvalRun(
	db: D1Database,
	id: number,
	fence: EvalRunFence,
	fenceValue: string,
	code: string,
	summary: string,
	now: Date,
): Promise<boolean> {
	const timestamp = now.toISOString();
	const statement =
		fence === "lease_token" ? db.prepare(FAIL_BY_LEASE_SQL) : db.prepare(FAIL_BY_WORKFLOW_SQL);
	const failed = await statement.bind(code, summary, timestamp, timestamp, id, fenceValue).run();
	return failed.meta.changes === 1;
}

export async function executeProductionLiveEvaluation(
	env: Env,
	runId: number,
	durability?: ProductionLiveEvaluationDurability,
): Promise<CompletedEvalRun> {
	const dataset = await retryProductionRead(() => loadProductionEvalDataset(env));
	const identity = await productionEvaluationIdentity(env, dataset);
	if (durability && !sameProductionEvaluationIdentity(durability.identity, identity)) {
		throw new Error("live evaluation runtime identity changed before durable resume");
	}
	const selectBaseline = () => readLatestBaselineReference(env, dataset.datasetHash, runId);
	const baselineReference = durability
		? await durability.selectBaseline(selectBaseline)
		: await selectBaseline();
	const baseline = baselineReference
		? await retryProductionRead(() => readBaselineArtifact(env, dataset, baselineReference))
		: null;
	const artifact = await runProtectedLiveEvaluation(
		{
			dataset,
			text: {
				modelId: env.LABELER_TEXT_MODEL_ID,
				promptHash: TEXT_PROMPT_HASH,
				configuredUnits: parseUnits(env.EVAL_TEXT_CONFIGURED_UNITS, "text"),
			},
			image: {
				modelId: env.LABELER_IMAGE_MODEL_ID,
				promptHash: IMAGE_PROMPT_HASH,
				configuredUnits: parseUnits(env.EVAL_IMAGE_CONFIGURED_UNITS, "image"),
				thinking: false,
			},
			repeatCount: 3,
			runnerCommit: env.VERSION_METADATA.id,
			...(durability ? { executedAt: durability.executedAt } : {}),
		},
		durability,
	);
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
	const report = renderEvalReport(candidate, dataset.budgets);
	const encoded = JSON.stringify(candidate);
	assertBoundedText(encoded, MAX_ARTIFACT_BYTES, "evaluation artifact");
	const artifactKey = `live/${candidate.reproducibility.executedAt}/${candidateHash}.json`;
	const storeArtifact = async (): Promise<void> => {
		await env.EVAL_ARTIFACTS.put(artifactKey, encoded, {
			httpMetadata: { contentType: "application/json" },
			customMetadata: {
				datasetHash: dataset.datasetHash,
				runnerCommit: env.VERSION_METADATA.id,
				candidateHash,
			},
		});
	};
	if (durability) await durability.storeArtifact(storeArtifact);
	else await storeArtifact();
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

export async function readProductionEvaluationIdentity(
	env: Env,
): Promise<ProductionEvaluationIdentity> {
	return productionEvaluationIdentity(env, await loadProductionEvalDataset(env));
}

function sameProductionEvaluationIdentity(
	left: ProductionEvaluationIdentity,
	right: ProductionEvaluationIdentity,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

async function productionEvaluationIdentity(
	env: Env,
	dataset: SealedEvalDataset,
): Promise<ProductionEvaluationIdentity> {
	return {
		schemaVersion: 1,
		datasetVersion: dataset.datasetVersion,
		datasetHash: dataset.datasetHash,
		budgetHash: await sha256Hex(JSON.stringify(dataset.budgets)),
		runnerVersion: EVAL_RUNNER_VERSION,
		runnerCommit: env.VERSION_METADATA.id,
		repeatCount: 3,
		textModelId: env.LABELER_TEXT_MODEL_ID,
		textPromptHash: TEXT_PROMPT_HASH,
		imageModelId: env.LABELER_IMAGE_MODEL_ID,
		imagePromptHash: IMAGE_PROMPT_HASH,
	};
}

async function loadProductionEvalDataset(env: Env): Promise<SealedEvalDataset> {
	const holdout = await env.EVAL_DATASETS.get("protected/holdout.json");
	if (!holdout) throw new Error("protected evaluation holdout is not configured");
	const holdoutBytes = await readBoundedEvalR2Object(
		holdout,
		MAX_PROTECTED_HOLDOUT_BYTES,
		"protected evaluation holdout",
	);
	return loadEvalDataset({
		readFile: async (path) => {
			const object = await env.EVAL_DATASETS.get(`v1/${path}`);
			if (!object) throw new Error(`evaluation dataset object is missing: ${path}`);
			return readBoundedEvalR2Object(
				object,
				MAX_PUBLIC_DATASET_OBJECT_BYTES,
				`evaluation dataset object ${path}`,
			);
		},
		protectedHoldout: { fixtureBytes: holdoutBytes },
	});
}

async function readLatestBaselineReference(
	env: Env,
	datasetHash: string,
	currentRunId: number,
): Promise<EvalBaselineReference | null> {
	const row = await env.DB.prepare(
		`SELECT id, artifact_key, candidate_hash
		 FROM eval_runs
		 WHERE status = 'succeeded' AND dataset_hash = ? AND id <> ?
		 ORDER BY completed_at DESC, id DESC
		 LIMIT 1`,
	)
		.bind(datasetHash, currentRunId)
		.first<{ id: number; artifact_key: string; candidate_hash: string }>();
	if (!row) return null;
	return { runId: row.id, artifactKey: row.artifact_key, candidateHash: row.candidate_hash };
}

async function readBaselineArtifact(
	env: Env,
	dataset: SealedEvalDataset,
	reference: EvalBaselineReference,
): Promise<{ runId: number; bundle: EvalResultBundle }> {
	const object = await env.EVAL_ARTIFACTS.get(reference.artifactKey);
	if (!object) throw new Error("evaluation baseline artifact is missing");
	const baselineBytes = await readBoundedEvalR2Object(
		object,
		MAX_ARTIFACT_BYTES,
		"evaluation baseline artifact",
	);
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(baselineBytes),
		);
	} catch {
		throw new Error("evaluation baseline artifact is invalid");
	}
	const bundle = evalResultBundle(parsed);
	assertEvalBundleIntegrity(bundle, dataset);
	if (bundle.mode !== "live" || (await hashBundle(bundle)) !== reference.candidateHash) {
		throw new Error("evaluation baseline artifact identity does not match its run");
	}
	return { runId: reference.runId, bundle };
}

export async function readBoundedEvalR2Object(
	object: EvalR2Object,
	maximumBytes: number,
	name: string,
): Promise<Uint8Array> {
	if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
		throw new TypeError("evaluation R2 byte limit is invalid");
	}
	if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > maximumBytes) {
		throw new RangeError(`${name} exceeds its byte limit`);
	}
	const bytes = new Uint8Array(await object.bytes());
	if (bytes.byteLength > maximumBytes) throw new RangeError(`${name} exceeds its byte limit`);
	return bytes;
}

async function retryProductionRead<T>(callback: () => Promise<T>): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= PRODUCTION_READ_RETRY_DELAYS_MS.length; attempt += 1) {
		try {
			return await callback();
		} catch (error) {
			lastError = error;
		}
		const delay = PRODUCTION_READ_RETRY_DELAYS_MS[attempt];
		if (delay !== undefined) await scheduler.wait(delay);
	}
	throw lastError;
}

interface StoredEvalRunRow {
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
	lease_token: string | null;
	lease_expires_at: string | null;
	workflow_instance_id: string | null;
}

const STORED_EVAL_RUN_SELECT = `SELECT id, idempotency_key, actor_did, actor_role, reason,
	status, result_json, comparison_json, report_markdown, failure_code, failure_summary,
	created_at, lease_token, lease_expires_at, workflow_instance_id FROM eval_runs`;

async function readEvalRun(db: D1Database, idempotencyKey: string): Promise<EvalRunRecord | null> {
	const row = await db
		.prepare(`${STORED_EVAL_RUN_SELECT} WHERE idempotency_key = ?`)
		.bind(idempotencyKey)
		.first<StoredEvalRunRow>();
	return row ? storedEvalRun(row) : null;
}

async function readEvalRunById(db: D1Database, id: number): Promise<EvalRunRecord | null> {
	const row = await db
		.prepare(`${STORED_EVAL_RUN_SELECT} WHERE id = ?`)
		.bind(id)
		.first<StoredEvalRunRow>();
	return row ? storedEvalRun(row) : null;
}

function storedEvalRun(row: StoredEvalRunRow): EvalRunRecord {
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
		...(row.lease_token ? { leaseToken: row.lease_token } : {}),
		...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
		...(row.workflow_instance_id ? { workflowInstanceId: row.workflow_instance_id } : {}),
	};
}

function startEvalRunHeartbeat(
	store: EvalRunStore,
	id: number,
	leaseToken: string,
): {
	stop(): Promise<boolean>;
} {
	let ownershipValid = true;
	let renewals = Promise.resolve();
	const timer = setInterval(() => {
		renewals = renewals
			.then(async () => {
				if (!(await store.renew(id, leaseToken, new Date()))) ownershipValid = false;
				return undefined;
			})
			.catch(() => {
				ownershipValid = false;
				return undefined;
			});
	}, EVAL_RUN_HEARTBEAT_MS);
	return {
		async stop() {
			clearInterval(timer);
			await renewals;
			return ownershipValid;
		},
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
		"outcomeMismatches",
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
