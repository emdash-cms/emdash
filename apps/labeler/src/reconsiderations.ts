import { ulid } from "ulidx";

import type { OperatorRole } from "./access-auth.js";

/** The resolution vocabulary (plan W10.6): `granted` (assessment revised in the
 * publisher's favour), `denied` (assessment upheld), `withdrawn` (requester
 * withdrew / duplicate / moot). Only `granted`/`denied` fire an outcome notice. */
export type ReconsiderationOutcome = "granted" | "denied" | "withdrawn";

export type ReconsiderationState = "open" | "resolved";

export interface StoredReconsideration {
	id: string;
	subjectUri: string;
	subjectCid: string;
	triggeringAssessmentId: string;
	state: ReconsiderationState;
	outcome: ReconsiderationOutcome | null;
	openedById: string;
	openedByEmail: string | null;
	openedByCommonName: string | null;
	openedByRole: OperatorRole;
	openedAt: string;
	openedAtEpochMs: number;
	resolvedById: string | null;
	resolvedByEmail: string | null;
	resolvedByCommonName: string | null;
	resolvedAt: string | null;
	resolvedAtEpochMs: number | null;
	outcomeActionId: string | null;
}

export interface StoredReconsiderationNote {
	id: string;
	reconsiderationId: string;
	authorId: string;
	authorEmail: string | null;
	authorCommonName: string | null;
	authorRole: OperatorRole;
	note: string;
	createdAt: string;
	createdAtEpochMs: number;
}

interface ReconsiderationRow {
	id: string;
	subject_uri: string;
	subject_cid: string;
	triggering_assessment_id: string;
	state: ReconsiderationState;
	outcome: ReconsiderationOutcome | null;
	opened_by_id: string;
	opened_by_email: string | null;
	opened_by_common_name: string | null;
	opened_by_role: OperatorRole;
	opened_at: string;
	opened_at_epoch_ms: number;
	resolved_by_id: string | null;
	resolved_by_email: string | null;
	resolved_by_common_name: string | null;
	resolved_at: string | null;
	resolved_at_epoch_ms: number | null;
	outcome_action_id: string | null;
}

interface ReconsiderationNoteRow {
	id: string;
	reconsideration_id: string;
	author_id: string;
	author_email: string | null;
	author_common_name: string | null;
	author_role: OperatorRole;
	note: string;
	created_at: string;
	created_at_epoch_ms: number;
}

export interface ReconsiderationInsert {
	id: string;
	subjectUri: string;
	subjectCid: string;
	triggeringAssessmentId: string;
	openedById: string;
	openedByEmail: string | null;
	openedByCommonName: string | null;
	openedByRole: OperatorRole;
	openedAt: string;
	openedAtEpochMs: number;
}

export interface ReconsiderationNoteInsert {
	id: string;
	reconsiderationId: string;
	authorId: string;
	authorEmail: string | null;
	authorCommonName: string | null;
	authorRole: OperatorRole;
	note: string;
	createdAt: string;
	createdAtEpochMs: number;
}

export interface ReconsiderationResolveUpdate {
	id: string;
	outcome: ReconsiderationOutcome;
	resolvedById: string;
	resolvedByEmail: string | null;
	resolvedByCommonName: string | null;
	resolvedAt: string;
	resolvedAtEpochMs: number;
	outcomeActionId: string;
}

export function newReconsiderationId(): string {
	return `rcn_${ulid()}`;
}

export function newReconsiderationNoteId(): string {
	return `rcnn_${ulid()}`;
}

/**
 * Insert for one case, always born `open` with a null outcome. A concurrent
 * second open for the same subject violates `idx_reconsiderations_open_subject`
 * and aborts the enclosing `db.batch` (see {@link isOpenReconsiderationConflict}).
 * Batched with its first note + the operational event + the operator_actions row
 * by `commitMutation`; never run alone.
 */
export function buildReconsiderationInsert(
	db: D1Database,
	input: ReconsiderationInsert,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO reconsiderations
			 (id, subject_uri, subject_cid, triggering_assessment_id, state, outcome,
			  opened_by_id, opened_by_email, opened_by_common_name, opened_by_role,
			  opened_at, opened_at_epoch_ms)
			 VALUES (?, ?, ?, ?, 'open', NULL, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.subjectUri,
			input.subjectCid,
			input.triggeringAssessmentId,
			input.openedById,
			input.openedByEmail,
			input.openedByCommonName,
			input.openedByRole,
			input.openedAt,
			input.openedAtEpochMs,
		);
}

/** Insert for one append-only private note. Batched with the operator_actions
 * row by `commitMutation`; never run alone. */
export function buildReconsiderationNoteInsert(
	db: D1Database,
	input: ReconsiderationNoteInsert,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO reconsideration_notes
			 (id, reconsideration_id, author_id, author_email, author_common_name,
			  author_role, note, created_at, created_at_epoch_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.reconsiderationId,
			input.authorId,
			input.authorEmail,
			input.authorCommonName,
			input.authorRole,
			input.note,
			input.createdAt,
			input.createdAtEpochMs,
		);
}

/**
 * Effect statement for a resolve. The `state = 'open'` predicate makes a second
 * concurrent resolve a zero-row UPDATE: the row flips exactly once and
 * `outcome_action_id` records the winner, so a loser that also committed its
 * audit row is detected post-commit and skips its outcome notice. Batched with
 * the operator_actions row + an optional final note + the operational event by
 * `commitMutation`.
 */
export function buildReconsiderationResolveUpdate(
	db: D1Database,
	input: ReconsiderationResolveUpdate,
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE reconsiderations
			 SET state = 'resolved', outcome = ?, resolved_by_id = ?, resolved_by_email = ?,
			     resolved_by_common_name = ?, resolved_at = ?, resolved_at_epoch_ms = ?,
			     outcome_action_id = ?
			 WHERE id = ? AND state = 'open'`,
		)
		.bind(
			input.outcome,
			input.resolvedById,
			input.resolvedByEmail,
			input.resolvedByCommonName,
			input.resolvedAt,
			input.resolvedAtEpochMs,
			input.outcomeActionId,
			input.id,
		);
}

const RECONSIDERATION_COLUMNS = `id, subject_uri, subject_cid, triggering_assessment_id, state,
	 outcome, opened_by_id, opened_by_email, opened_by_common_name, opened_by_role,
	 opened_at, opened_at_epoch_ms, resolved_by_id, resolved_by_email, resolved_by_common_name,
	 resolved_at, resolved_at_epoch_ms, outcome_action_id`;

/** The single open case for a subject, or null. Backed by the partial unique
 * index, so at most one row can match. */
export async function getOpenCaseForSubject(
	db: D1Database,
	subjectUri: string,
	subjectCid: string,
): Promise<StoredReconsideration | null> {
	const row = await db
		.prepare(
			`SELECT ${RECONSIDERATION_COLUMNS} FROM reconsiderations
			 WHERE subject_uri = ? AND subject_cid = ? AND state = 'open'`,
		)
		.bind(subjectUri, subjectCid)
		.first<ReconsiderationRow>();
	return row ? rowToStoredReconsideration(row) : null;
}

export async function getReconsiderationById(
	db: D1Database,
	id: string,
): Promise<StoredReconsideration | null> {
	const row = await db
		.prepare(`SELECT ${RECONSIDERATION_COLUMNS} FROM reconsiderations WHERE id = ?`)
		.bind(id)
		.first<ReconsiderationRow>();
	return row ? rowToStoredReconsideration(row) : null;
}

/**
 * Case page, newest first, exclusive keyset on `(opened_at_epoch_ms, id)` over
 * `idx_reconsiderations_opened`. Fetches `limit + 1` so the caller detects a next
 * page without a trailing COUNT — matching `getOperatorActionsPage`.
 */
export async function getReconsiderationsPage(
	db: D1Database,
	keyset: { createdAt: string; id: string } | null,
	limit: number,
): Promise<StoredReconsideration[]> {
	const bindings: (string | number)[] = [];
	let where = "";
	if (keyset !== null) {
		const epochMs = Date.parse(keyset.createdAt);
		where = `WHERE (opened_at_epoch_ms < ? OR (opened_at_epoch_ms = ? AND id < ?))`;
		bindings.push(epochMs, epochMs, keyset.id);
	}
	bindings.push(limit + 1);
	const rows = await db
		.prepare(
			`SELECT ${RECONSIDERATION_COLUMNS} FROM reconsiderations ${where}
			 ORDER BY opened_at_epoch_ms DESC, id DESC
			 LIMIT ?`,
		)
		.bind(...bindings)
		.all<ReconsiderationRow>();
	return (rows.results ?? []).map(rowToStoredReconsideration);
}

/** Notes for one case, oldest first (the order an operator reads the thread). */
export async function getNotesForReconsideration(
	db: D1Database,
	reconsiderationId: string,
): Promise<StoredReconsiderationNote[]> {
	const rows = await db
		.prepare(
			`SELECT id, reconsideration_id, author_id, author_email, author_common_name,
			 author_role, note, created_at, created_at_epoch_ms
			 FROM reconsideration_notes
			 WHERE reconsideration_id = ?
			 ORDER BY created_at_epoch_ms ASC, id ASC`,
		)
		.bind(reconsiderationId)
		.all<ReconsiderationNoteRow>();
	return (rows.results ?? []).map(rowToStoredReconsiderationNote);
}

/**
 * True when `error` is the D1 UNIQUE violation on the open-case partial index.
 * `commitMutation` rethrows any non-idempotency-key violation, so the open
 * handler catches this around its commit to report a duplicate-open 409 rather
 * than a 500 on the race between its pre-check and the batch.
 */
export function isOpenReconsiderationConflict(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes(
			"UNIQUE constraint failed: reconsiderations.subject_uri, reconsiderations.subject_cid",
		)
	);
}

function rowToStoredReconsideration(row: ReconsiderationRow): StoredReconsideration {
	return {
		id: row.id,
		subjectUri: row.subject_uri,
		subjectCid: row.subject_cid,
		triggeringAssessmentId: row.triggering_assessment_id,
		state: row.state,
		outcome: row.outcome,
		openedById: row.opened_by_id,
		openedByEmail: row.opened_by_email,
		openedByCommonName: row.opened_by_common_name,
		openedByRole: row.opened_by_role,
		openedAt: row.opened_at,
		openedAtEpochMs: row.opened_at_epoch_ms,
		resolvedById: row.resolved_by_id,
		resolvedByEmail: row.resolved_by_email,
		resolvedByCommonName: row.resolved_by_common_name,
		resolvedAt: row.resolved_at,
		resolvedAtEpochMs: row.resolved_at_epoch_ms,
		outcomeActionId: row.outcome_action_id,
	};
}

function rowToStoredReconsiderationNote(row: ReconsiderationNoteRow): StoredReconsiderationNote {
	return {
		id: row.id,
		reconsiderationId: row.reconsideration_id,
		authorId: row.author_id,
		authorEmail: row.author_email,
		authorCommonName: row.author_common_name,
		authorRole: row.author_role,
		note: row.note,
		createdAt: row.created_at,
		createdAtEpochMs: row.created_at_epoch_ms,
	};
}
