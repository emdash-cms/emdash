/**
 * Minimal reconciliation (plan W6.8). A scheduled() cron handler calls
 * `reconcileAssessments` to surface two operational gaps as structured
 * `console.error` lines (W11.3 turns these into alerts):
 *
 *   - Runs stuck in verifying/pending/running past a staleness threshold —
 *     the discovery consumer (or, once wired, the orchestrator) crashed or
 *     stalled mid-flight.
 *   - Verified, non-deleted subjects with no assessment row at all — a
 *     discovery event was verified but the run-creation step never
 *     happened or left no trace.
 *
 * Aggregator cross-check reconciliation and scanner-intelligence triggers
 * (plan W6.7) are out of scope for this PR.
 */

import type { AssessmentState } from "./assessment-lifecycle.js";

const STUCK_STATES: readonly AssessmentState[] = ["verifying", "pending", "running"];
const DEFAULT_STALE_THRESHOLD_MS = 60 * 60 * 1000;

export interface StuckAssessmentRun {
	id: string;
	uri: string;
	cid: string;
	state: AssessmentState;
	createdAt: string;
}

export interface OrphanedSubject {
	uri: string;
	cid: string;
}

export interface ReconciliationReport {
	stuckRuns: readonly StuckAssessmentRun[];
	subjectsWithoutRuns: readonly OrphanedSubject[];
}

export async function reconcileAssessments(
	db: D1Database,
	now: Date,
	staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS,
): Promise<ReconciliationReport> {
	const staleBefore = now.getTime() - staleThresholdMs;

	const stuckRows = await db
		.prepare(
			`SELECT id, uri, cid, state, created_at FROM assessments
			 WHERE state IN (${STUCK_STATES.map(() => "?").join(", ")}) AND created_at_epoch_ms < ?`,
		)
		.bind(...STUCK_STATES, staleBefore)
		.all<{ id: string; uri: string; cid: string; state: AssessmentState; created_at: string }>();
	const stuckRuns: StuckAssessmentRun[] = (stuckRows.results ?? []).map((row) => ({
		id: row.id,
		uri: row.uri,
		cid: row.cid,
		state: row.state,
		createdAt: row.created_at,
	}));
	for (const run of stuckRuns) {
		console.error("[labeler] reconciliation: assessment run stuck", run);
	}

	const orphanRows = await db
		.prepare(
			`SELECT s.uri, s.cid FROM subjects s
			 WHERE s.deleted_at IS NULL
			 AND NOT EXISTS (SELECT 1 FROM assessments a WHERE a.uri = s.uri AND a.cid = s.cid)`,
		)
		.all<OrphanedSubject>();
	const subjectsWithoutRuns = orphanRows.results ?? [];
	for (const subject of subjectsWithoutRuns) {
		console.error("[labeler] reconciliation: verified subject has no assessment run", subject);
	}

	return { stuckRuns, subjectsWithoutRuns };
}
