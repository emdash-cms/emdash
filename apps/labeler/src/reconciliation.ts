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

/** How long a committed label may sit `publication_pending` before the sweep
 * re-drives its subscription-DO notify. Short relative to the stuck-run
 * threshold: a stranded pending row blocks the next key rotation. */
const DEFAULT_PUBLICATION_STALE_THRESHOLD_MS = 5 * 60 * 1000;

/** Per-pass cap on re-driven publications. The 5-minute cron reconvenes to drain
 * a larger backlog across passes rather than fan out an unbounded batch. */
const PUBLICATION_SWEEP_LIMIT = 200;

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

export interface PendingPublicationSweepDeps {
	db: D1Database;
	/** Drives the subscription-DO notify for one committed sequence. The DO
	 * broadcasts it and clears `publication_pending`; a throw leaves the flag set
	 * for the next pass. */
	notify: (sequence: number) => Promise<void>;
	now: Date;
	thresholdMs?: number;
	limit?: number;
}

export interface PendingPublicationSweepReport {
	redriven: number;
	failed: number;
}

/**
 * Durable backstop for the live post-commit notify (assessment finalization and
 * the console mutation path both issue labels `publication_pending = 1` and
 * broadcast off the response path). A transient notify failure otherwise strands
 * the row pending forever — an aggregator never receives it and, worse, the next
 * key rotation refuses to activate while a row signed with the outgoing key stays
 * pending. This re-drives the DO notify for pending rows older than the
 * threshold; the DO clears the flag on success.
 */
export async function sweepPendingPublications(
	deps: PendingPublicationSweepDeps,
): Promise<PendingPublicationSweepReport> {
	const thresholdMs = deps.thresholdMs ?? DEFAULT_PUBLICATION_STALE_THRESHOLD_MS;
	const limit = deps.limit ?? PUBLICATION_SWEEP_LIMIT;
	const staleBefore = new Date(deps.now.getTime() - thresholdMs).toISOString();

	const rows = await deps.db
		.prepare(
			`SELECT sequence FROM issued_labels
			 WHERE publication_pending = 1 AND sequence IS NOT NULL AND cts <= ?
			 ORDER BY sequence ASC LIMIT ?`,
		)
		.bind(staleBefore, limit)
		.all<{ sequence: number }>();

	let redriven = 0;
	let failed = 0;
	for (const row of rows.results ?? []) {
		try {
			await deps.notify(row.sequence);
			redriven++;
		} catch (error) {
			failed++;
			console.error("[labeler] reconciliation: publication redrive failed", {
				sequence: row.sequence,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { redriven, failed };
}
