import type { AssessmentWorkflowBinding } from "../assessment/dispatch.js";
import type { AssessmentLifecycleStore } from "../assessment/lifecycle.js";
import { createAssessmentWorkflowParams } from "../assessment/run-key.js";
import type {
	AssessmentRunState,
	AssessmentSubject,
	AssessmentVersionSet,
	AssessmentWorkflowParams,
} from "../assessment/types.js";
import { ensureAssessmentWorkflowRuns, type ReconciliationWorkflowPresence } from "./workflows.js";

export type { ReconciliationWorkflowPresence } from "./workflows.js";

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 100;
const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1_000;
const RECONCILIATION_TRIGGER_PREFIX = "reconciliation-v1-";

export type ExpectedAssessmentLabel = "listing-passed" | "listing-review" | "listing-error";

export interface MissingAssessmentLabel {
	assessmentId: string;
	runKey: string;
	subject: AssessmentSubject;
	outcome: "passed" | "review" | "error";
	expectedLabel: ExpectedAssessmentLabel;
	policyVersion: string;
	completedAt: string | null;
}

export interface StaleAssessmentRun {
	assessmentId: string;
	runKey: string;
	subject: AssessmentSubject;
	state: "pending" | "running";
	updatedAt: string;
}

export interface QuarantinedDiscoveryItem {
	quarantineId: string;
	cursor: string;
	reason: string;
	eventSummary: string;
	observedAt: string;
	revision: number;
}

export interface ReconciliationScan {
	repairCandidates: readonly AssessmentSubject[];
	missingOutcomeLabels: readonly MissingAssessmentLabel[];
	staleRuns: readonly StaleAssessmentRun[];
	quarantinedItems: readonly QuarantinedDiscoveryItem[];
}

export interface ReconciliationScanOptions {
	limit: number;
	staleBefore: string;
	expectedLabelSource: string;
	versions: AssessmentVersionSet;
}

export interface LabelerReconciliationStore {
	scan(options: ReconciliationScanOptions): Promise<ReconciliationScan>;
}

export interface LabelerReconciliationDependencies {
	store: LabelerReconciliationStore;
	lifecycle: AssessmentLifecycleStore;
	workflow: AssessmentWorkflowBinding;
	workflowPresence(runKey: string): Promise<ReconciliationWorkflowPresence>;
	restartWorkflow(runKey: string): Promise<void>;
	versions: AssessmentVersionSet;
	expectedLabelSource: string;
	now?: () => Date;
	batchSize?: number;
	staleAfterMs?: number;
}

export interface LabelerReconciliationReport extends ReconciliationScan {
	observedAt: string;
	staleBefore: string;
	batchSize: number;
	ensuredRunKeys: readonly string[];
	dispatchedRunKeys: readonly string[];
	restartedWorkflowRunKeys: readonly string[];
	existingWorkflowRunKeys: readonly string[];
}

export async function reconcileLabeler(
	dependencies: LabelerReconciliationDependencies,
): Promise<LabelerReconciliationReport> {
	const batchSize = parseBatchSize(dependencies.batchSize ?? DEFAULT_BATCH_SIZE);
	const staleAfterMs = parseStaleAfterMs(dependencies.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
	const now = dependencies.now?.() ?? new Date();
	if (!Number.isFinite(now.getTime())) throw new TypeError("reconciliation time is invalid");
	if (dependencies.expectedLabelSource.length === 0) {
		throw new TypeError("expected label source is required");
	}
	const observedAt = now.toISOString();
	const staleBefore = new Date(now.getTime() - staleAfterMs).toISOString();
	const scan = await dependencies.store.scan({
		limit: batchSize,
		staleBefore,
		expectedLabelSource: dependencies.expectedLabelSource,
		versions: dependencies.versions,
	});
	assertBoundedScan(scan, batchSize);

	const params: AssessmentWorkflowParams[] = [];
	for (const subject of scan.repairCandidates) {
		const workflowParams = await createAssessmentWorkflowParams({
			subject,
			versions: dependencies.versions,
			logicalTriggerId: await createReconciliationTriggerId(subject),
		});
		await dependencies.lifecycle.observeRun({
			params: workflowParams,
			observedAt,
			makeCurrent: false,
		});
		params.push(workflowParams);
	}

	const ensured = await ensureAssessmentWorkflowRuns({
		workflow: dependencies.workflow,
		workflowPresence: dependencies.workflowPresence,
		restartWorkflow: dependencies.restartWorkflow,
		runs: params,
	});

	return {
		...scan,
		observedAt,
		staleBefore,
		batchSize,
		ensuredRunKeys: params.map(({ runKey }) => runKey),
		dispatchedRunKeys: ensured.dispatchedRunKeys,
		restartedWorkflowRunKeys: ensured.restartedRunKeys,
		existingWorkflowRunKeys: ensured.existingWorkflowRunKeys,
	};
}

export function createD1LabelerReconciliationStore(db: D1Database): LabelerReconciliationStore {
	return {
		async scan(options) {
			const limit = parseBatchSize(options.limit);
			const [repair, missingLabels, stale, quarantine] = await Promise.all([
				db
					.prepare(
						`SELECT current.uri, current.cid, current.kind
						 FROM current_subjects current
						 JOIN subjects subject
						   ON subject.uri = current.uri AND subject.cid = current.cid
						 LEFT JOIN current_assessments current_assessment
						   ON current_assessment.subject_uri = current.uri
						  AND current_assessment.subject_cid = current.cid
						 LEFT JOIN assessments assessment
						   ON assessment.id = current_assessment.assessment_id
						  AND assessment.subject_uri = current.uri
						  AND assessment.subject_cid = current.cid
						 WHERE current.deleted_at IS NULL
						   AND subject.deleted_at IS NULL
						   AND (
							 assessment.id IS NULL
							 OR assessment.state IN ('cancelled', 'superseded')
							 OR assessment.policy_version <> ?
							 OR assessment.parser_version <> ?
							 OR assessment.text_model_id <> ?
							 OR assessment.text_prompt_hash <> ?
							 OR assessment.image_model_id <> ?
							 OR assessment.image_prompt_hash <> ?
							 OR (
								assessment.state IN ('pending', 'running')
								AND assessment.logical_trigger_id LIKE ?
							 )
						   )
						 ORDER BY current.updated_at, current.uri
						 LIMIT ?`,
					)
					.bind(
						options.versions.policyVersion,
						options.versions.parserVersion,
						options.versions.textModelId,
						options.versions.textPromptHash,
						options.versions.imageModelId,
						options.versions.imagePromptHash,
						`${RECONCILIATION_TRIGGER_PREFIX}%`,
						limit,
					)
					.all<SubjectRow>(),
				db
					.prepare(
						`SELECT assessment.id AS assessment_id, assessment.run_key,
						        assessment.subject_uri, assessment.subject_cid,
						        assessment.subject_kind, assessment.state,
						        assessment.completed_at, assessment.policy_version
						 FROM current_assessments current_assessment
						 JOIN assessments assessment
						   ON assessment.id = current_assessment.assessment_id
						  AND assessment.subject_uri = current_assessment.subject_uri
						  AND assessment.subject_cid = current_assessment.subject_cid
						 JOIN current_subjects current
						   ON current.uri = assessment.subject_uri
						  AND current.cid = assessment.subject_cid
						 JOIN subjects subject
						   ON subject.uri = assessment.subject_uri
						  AND subject.cid = assessment.subject_cid
						 WHERE current.deleted_at IS NULL
						   AND subject.deleted_at IS NULL
						   AND assessment.state IN ('passed', 'review', 'error')
						   AND assessment.error_code IS NULL
						   AND NOT EXISTS (
						     SELECT 1 FROM operator_actions decision
						     WHERE decision.subject_uri = assessment.subject_uri
						       AND decision.subject_cid = assessment.subject_cid
						       AND decision.action IN ('approve', 'block')
						   )
						   AND NOT EXISTS (
							 SELECT 1 FROM issued_labels label
							 WHERE label.assessment_id = assessment.id
							   AND label.assessment_policy_version = assessment.policy_version
							   AND label.assessment_outcome = assessment.state
							   AND label.actor_role = 'automation'
							   AND label.actor_did = ?
							   AND label.src = ?
							   AND label.uri = assessment.subject_uri
							   AND label.cid = assessment.subject_cid
							   AND label.val = CASE assessment.state
								 WHEN 'passed' THEN 'listing-passed'
								 WHEN 'review' THEN 'listing-review'
								 ELSE 'listing-error'
							   END
							   AND label.neg = 0
							   AND length(label.sig) > 0
							   AND length(label.signing_key_id) > 0
						   )
						 ORDER BY assessment.completed_at, assessment.id
						 LIMIT ?`,
					)
					.bind(options.expectedLabelSource, options.expectedLabelSource, limit)
					.all<MissingLabelRow>(),
				db
					.prepare(
						`SELECT assessment.id AS assessment_id, assessment.run_key,
						        assessment.subject_uri, assessment.subject_cid,
						        assessment.subject_kind, assessment.state,
						        assessment.updated_at
						 FROM assessments assessment
						 JOIN subjects subject
						   ON subject.uri = assessment.subject_uri
						  AND subject.cid = assessment.subject_cid
						 WHERE subject.deleted_at IS NULL
						   AND assessment.state IN ('pending', 'running')
						   AND assessment.updated_at < ?
						 ORDER BY assessment.updated_at, assessment.id
						 LIMIT ?`,
					)
					.bind(options.staleBefore, limit)
					.all<StaleRunRow>(),
				db
					.prepare(
						`SELECT quarantine_id, cursor, reason, event_summary, observed_at, revision
						 FROM discovery_quarantine_events
						 WHERE requires_reconciliation = 1
						 ORDER BY observed_at, cursor, quarantine_id
						 LIMIT ?`,
					)
					.bind(limit)
					.all<QuarantineRow>(),
			]);

			return {
				repairCandidates: repair.results.map(subjectFromRow),
				missingOutcomeLabels: missingLabels.results.map(missingLabelFromRow),
				staleRuns: stale.results.map(staleRunFromRow),
				quarantinedItems: quarantine.results.map((row) => ({
					quarantineId: row.quarantine_id,
					cursor: row.cursor,
					reason: row.reason,
					eventSummary: row.event_summary,
					observedAt: row.observed_at,
					revision: row.revision,
				})),
			};
		},
	};
}

async function createReconciliationTriggerId(subject: AssessmentSubject): Promise<string> {
	const encoded = new TextEncoder().encode(JSON.stringify([1, subject.uri, subject.cid]));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
	return `${RECONCILIATION_TRIGGER_PREFIX}${toHex(digest)}`;
}

function assertBoundedScan(scan: ReconciliationScan, limit: number): void {
	for (const [name, values] of Object.entries(scan)) {
		if (values.length > limit) {
			throw new RangeError(`reconciliation ${name} exceeded its requested batch limit`);
		}
	}
}

function parseBatchSize(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BATCH_SIZE) {
		throw new RangeError(`reconciliation batch size must be between 1 and ${MAX_BATCH_SIZE}`);
	}
	return value;
}

function parseStaleAfterMs(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError("reconciliation stale threshold must be a non-negative integer");
	}
	return value;
}

interface SubjectRow {
	uri: string;
	cid: string;
	kind: AssessmentSubject["kind"];
}

interface MissingLabelRow {
	assessment_id: string;
	run_key: string;
	subject_uri: string;
	subject_cid: string;
	subject_kind: AssessmentSubject["kind"];
	state: AssessmentRunState;
	completed_at: string | null;
	policy_version: string;
}

interface StaleRunRow {
	assessment_id: string;
	run_key: string;
	subject_uri: string;
	subject_cid: string;
	subject_kind: AssessmentSubject["kind"];
	state: AssessmentRunState;
	updated_at: string;
}

interface QuarantineRow {
	quarantine_id: string;
	cursor: string;
	reason: string;
	event_summary: string;
	observed_at: string;
	revision: number;
}

function subjectFromRow(row: SubjectRow): AssessmentSubject {
	return { uri: row.uri, cid: row.cid, kind: row.kind };
}

function missingLabelFromRow(row: MissingLabelRow): MissingAssessmentLabel {
	if (row.state !== "passed" && row.state !== "review" && row.state !== "error") {
		throw new Error("reconciliation query returned a non-terminal automated assessment");
	}
	return {
		assessmentId: row.assessment_id,
		runKey: row.run_key,
		subject: {
			uri: row.subject_uri,
			cid: row.subject_cid,
			kind: row.subject_kind,
		},
		outcome: row.state,
		expectedLabel:
			row.state === "passed"
				? "listing-passed"
				: row.state === "review"
					? "listing-review"
					: "listing-error",
		completedAt: row.completed_at,
		policyVersion: row.policy_version,
	};
}

function staleRunFromRow(row: StaleRunRow): StaleAssessmentRun {
	if (row.state !== "pending" && row.state !== "running") {
		throw new Error("reconciliation query returned a non-active assessment");
	}
	return {
		assessmentId: row.assessment_id,
		runKey: row.run_key,
		subject: {
			uri: row.subject_uri,
			cid: row.subject_cid,
			kind: row.subject_kind,
		},
		state: row.state,
		updatedAt: row.updated_at,
	};
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
