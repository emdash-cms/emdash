/**
 * Persistence for the prolonged-error escalation ladder (plan W10.5 follow-up).
 * `assessment_error_escalations` (migration 0010) tracks, per errored
 * assessment, whether the 24h operator alert and the 72h publisher notice have
 * already fired — the tracking table that makes each stage idempotent across the
 * 5-minute reconciliation cron ticks.
 *
 * The escalation query deliberately does NOT reuse the pointer-based
 * `isSuperseded` (an `error` run never moves the `current_assessments` pointer,
 * spec §10): supersession here means simply "a newer run exists for the same
 * `(uri, cid)`", detected by `created_at_epoch_ms`.
 */

import { PROLONGED_ERROR_OPERATOR_THRESHOLD_MS, PROLONGED_ERROR_SCAN_BATCH } from "./constants.js";

export interface EscalatableError {
	id: string;
	uri: string;
	cid: string;
	completedAtEpochMs: number;
}

export interface AssessmentErrorEscalation {
	assessmentId: string;
	subjectUri: string;
	subjectCid: string;
	operatorAlertedAtEpochMs: number | null;
	publisherNotifiedAtEpochMs: number | null;
	createdAtEpochMs: number;
}

interface EscalatableErrorRow {
	id: string;
	uri: string;
	cid: string;
	completed_at_epoch_ms: number;
}

interface EscalationRow {
	assessment_id: string;
	subject_uri: string;
	subject_cid: string;
	operator_alerted_at_epoch_ms: number | null;
	publisher_notified_at_epoch_ms: number | null;
	created_at_epoch_ms: number;
}

/**
 * Terminal `error` assessments whose `completed_at` is at least the operator
 * threshold (24h) old and that no newer run has superseded — the candidate set
 * for the escalation ladder. Skips subjects tombstoned at the source (a deleted
 * release warrants no publisher chase) and rows whose escalation is already
 * complete (both marks stamped), so a fully-escalated row leaves the
 * `completed_at`-ordered window and newer errors behind it are reached during a
 * backlog. Capped at {@link PROLONGED_ERROR_SCAN_BATCH}; a full page is logged so
 * a persistent backlog is visible.
 */
export async function findEscalatableErrors(
	db: D1Database,
	now: Date,
): Promise<EscalatableError[]> {
	const operatorBefore = now.getTime() - PROLONGED_ERROR_OPERATOR_THRESHOLD_MS;
	const rows = await db
		.prepare(
			`SELECT a.id, a.uri, a.cid, a.completed_at_epoch_ms
			 FROM assessments a
			 JOIN subjects s ON s.uri = a.uri AND s.cid = a.cid
			 LEFT JOIN assessment_error_escalations e ON e.assessment_id = a.id
			 WHERE a.state = 'error'
			   AND a.completed_at_epoch_ms IS NOT NULL
			   AND a.completed_at_epoch_ms <= ?
			   AND s.deleted_at IS NULL
			   AND (
				e.assessment_id IS NULL
				OR e.operator_alerted_at_epoch_ms IS NULL
				OR e.publisher_notified_at_epoch_ms IS NULL
			   )
			   AND NOT EXISTS (
				SELECT 1 FROM assessments b
				WHERE b.uri = a.uri AND b.cid = a.cid AND b.created_at_epoch_ms > a.created_at_epoch_ms
			   )
			 ORDER BY a.completed_at_epoch_ms ASC
			 LIMIT ?`,
		)
		.bind(operatorBefore, PROLONGED_ERROR_SCAN_BATCH)
		.all<EscalatableErrorRow>();
	const results = rows.results ?? [];
	if (results.length >= PROLONGED_ERROR_SCAN_BATCH)
		console.error("[labeler] prolonged-error escalation scan hit the batch cap", {
			cap: PROLONGED_ERROR_SCAN_BATCH,
		});
	return results.map((row) => ({
		id: row.id,
		uri: row.uri,
		cid: row.cid,
		completedAtEpochMs: row.completed_at_epoch_ms,
	}));
}

/** Guarantee a tracking row exists for an errored assessment, leaving both mark
 * columns null. Idempotent: a repeated cron tick keeps the first row's marks. */
export async function ensureEscalationRow(
	db: D1Database,
	input: { assessmentId: string; subjectUri: string; subjectCid: string; now: Date },
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO assessment_error_escalations
				(assessment_id, subject_uri, subject_cid, created_at, created_at_epoch_ms)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(assessment_id) DO NOTHING`,
		)
		.bind(
			input.assessmentId,
			input.subjectUri,
			input.subjectCid,
			input.now.toISOString(),
			input.now.getTime(),
		)
		.run();
}

export async function getEscalation(
	db: D1Database,
	assessmentId: string,
): Promise<AssessmentErrorEscalation | null> {
	const row = await db
		.prepare(
			`SELECT assessment_id, subject_uri, subject_cid,
			 operator_alerted_at_epoch_ms, publisher_notified_at_epoch_ms, created_at_epoch_ms
			 FROM assessment_error_escalations WHERE assessment_id = ?`,
		)
		.bind(assessmentId)
		.first<EscalationRow>();
	return row
		? {
				assessmentId: row.assessment_id,
				subjectUri: row.subject_uri,
				subjectCid: row.subject_cid,
				operatorAlertedAtEpochMs: row.operator_alerted_at_epoch_ms,
				publisherNotifiedAtEpochMs: row.publisher_notified_at_epoch_ms,
				createdAtEpochMs: row.created_at_epoch_ms,
			}
		: null;
}

/**
 * The statement that stamps `operator_alerted_at`, guarded on it still being
 * null. Returned rather than executed so the caller can batch it atomically with
 * the operational-event insert — a crash can then never leave the alert raised
 * without the mark (which would re-alert on the next tick).
 */
export function buildMarkOperatorAlerted(
	db: D1Database,
	assessmentId: string,
	now: Date,
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE assessment_error_escalations
			 SET operator_alerted_at_epoch_ms = ?
			 WHERE assessment_id = ? AND operator_alerted_at_epoch_ms IS NULL`,
		)
		.bind(now.getTime(), assessmentId);
}

/** Stamp `publisher_notified_at`, guarded on it still being null. Runs after the
 * notice trigger returns; the notice's own `(issuance, id)` dedup makes a crash
 * between send and mark self-heal (the next tick re-sends nothing, then marks). */
export async function markPublisherNotified(
	db: D1Database,
	assessmentId: string,
	now: Date,
): Promise<void> {
	await db
		.prepare(
			`UPDATE assessment_error_escalations
			 SET publisher_notified_at_epoch_ms = ?
			 WHERE assessment_id = ? AND publisher_notified_at_epoch_ms IS NULL`,
		)
		.bind(now.getTime(), assessmentId)
		.run();
}
