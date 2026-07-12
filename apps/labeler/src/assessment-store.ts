import { ulid } from "ulidx";

import {
	ASSESSMENT_ID,
	AssessmentTransitionConflictError,
	CURRENT_POINTER_STATES,
	isLegalTransition,
	TERMINAL_STATES,
	type AssessmentState,
	type PublicAssessmentState,
} from "./assessment-lifecycle.js";

const DECISION_OUTCOME_STATES: ReadonlySet<AssessmentState> = new Set([
	"passed",
	"warned",
	"blocked",
	"error",
]);

export interface Assessment {
	id: string;
	runKey: string;
	uri: string;
	cid: string;
	artifactId: string | null;
	artifactChecksum: string | null;
	state: AssessmentState;
	trigger: string;
	triggerId: string;
	policyVersion: string;
	modelId: string | null;
	promptHash: string | null;
	publicSummary: string | null;
	coverageJson: string;
	supersedesAssessmentId: string | null;
	startedAt: string | null;
	completedAt: string | null;
	createdAt: string;
}

interface AssessmentRow {
	id: string;
	run_key: string;
	uri: string;
	cid: string;
	artifact_id: string | null;
	artifact_checksum: string | null;
	state: AssessmentState;
	trigger: string;
	trigger_id: string;
	policy_version: string;
	model_id: string | null;
	prompt_hash: string | null;
	public_summary: string | null;
	coverage_json: string;
	supersedes_assessment_id: string | null;
	started_at: string | null;
	completed_at: string | null;
	created_at: string;
}

export interface CreateSubjectInput {
	uri: string;
	cid: string;
	did: string;
	collection: string;
	rkey: string;
	now?: Date;
}

/**
 * Idempotent: verification may observe the same (uri, cid) more than once.
 * A verified re-observation reactivates a tombstoned row (the create path
 * only reaches here after the PDS confirms the record exists, so clearing
 * `deleted_at` is correct — it closes the delete-then-recreate race and
 * handles a genuine republish of the same rkey+cid).
 */
export async function createSubject(db: D1Database, input: CreateSubjectInput): Promise<void> {
	const now = input.now ?? new Date();
	await db
		.prepare(
			`INSERT INTO subjects (uri, cid, did, collection, rkey, observed_at, observed_at_epoch_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(uri, cid) DO UPDATE SET
			   did = excluded.did,
			   collection = excluded.collection,
			   rkey = excluded.rkey,
			   observed_at = excluded.observed_at,
			   observed_at_epoch_ms = excluded.observed_at_epoch_ms,
			   deleted_at = NULL,
			   deleted_at_epoch_ms = NULL`,
		)
		.bind(
			input.uri,
			input.cid,
			input.did,
			input.collection,
			input.rkey,
			now.toISOString(),
			now.getTime(),
		)
		.run();
}

export async function deleteSubject(
	db: D1Database,
	input: { uri: string; cid: string; now?: Date },
): Promise<void> {
	const now = input.now ?? new Date();
	await db
		.prepare(
			`UPDATE subjects SET deleted_at = ?, deleted_at_epoch_ms = ?
			 WHERE uri = ? AND cid = ? AND deleted_at IS NULL`,
		)
		.bind(now.toISOString(), now.getTime(), input.uri, input.cid)
		.run();
}

/**
 * Tombstones every non-deleted subject row for a URI, regardless of CID. A
 * Jetstream delete event names (did, collection, rkey) — the URI — but not
 * which CID revision is gone, so every observed CID at that URI is now
 * unreachable at the source.
 */
export async function deleteSubjectsByUri(
	db: D1Database,
	input: { uri: string; now?: Date },
): Promise<void> {
	const now = input.now ?? new Date();
	await db
		.prepare(
			`UPDATE subjects SET deleted_at = ?, deleted_at_epoch_ms = ?
			 WHERE uri = ? AND deleted_at IS NULL`,
		)
		.bind(now.toISOString(), now.getTime(), input.uri)
		.run();
}

/**
 * A subject is current when its row isn't tombstoned and no later-observed,
 * non-deleted subject at the same URI carries a different CID. Used
 * immediately before finalization (spec §10): a deleted or superseded
 * subject finalizes as `stale` rather than issuing new labels.
 */
export async function isSubjectCurrent(
	db: D1Database,
	input: { uri: string; cid: string },
): Promise<boolean> {
	const row = await db
		.prepare(`SELECT deleted_at, observed_at_epoch_ms FROM subjects WHERE uri = ? AND cid = ?`)
		.bind(input.uri, input.cid)
		.first<{ deleted_at: string | null; observed_at_epoch_ms: number }>();
	if (!row || row.deleted_at !== null) return false;
	// Deterministic tie-break on equal observed_at_epoch_ms: a same-instant
	// sibling with a greater CID is treated as newer, so exactly one subject
	// at a URI is ever "current" even when two are observed in the same
	// millisecond.
	const newer = await db
		.prepare(
			`SELECT 1 FROM subjects
			 WHERE uri = ? AND cid != ? AND deleted_at IS NULL
			   AND (observed_at_epoch_ms > ? OR (observed_at_epoch_ms = ? AND cid > ?))
			 LIMIT 1`,
		)
		.bind(input.uri, input.cid, row.observed_at_epoch_ms, row.observed_at_epoch_ms, input.cid)
		.first();
	return !newer;
}

export interface CreateAssessmentRunInput {
	runKey: string;
	uri: string;
	cid: string;
	artifactId?: string;
	artifactChecksum?: string;
	trigger: string;
	triggerId: string;
	policyVersion: string;
	modelId?: string;
	promptHash?: string;
	coverageJson: string;
	now?: Date;
}

export interface CreateAssessmentRunResult {
	assessment: Assessment;
	created: boolean;
}

/**
 * Idempotent run creation keyed on `run_key`: redelivery of the same logical
 * trigger observes the existing run rather than creating a second one.
 */
export async function createAssessmentRun(
	db: D1Database,
	input: CreateAssessmentRunInput,
): Promise<CreateAssessmentRunResult> {
	const id = `asmt_${ulid()}`;
	const now = input.now ?? new Date();
	await db
		.prepare(
			`INSERT INTO assessments
			 (id, run_key, uri, cid, artifact_id, artifact_checksum, state, trigger, trigger_id,
			  policy_version, model_id, prompt_hash, coverage_json,
			  created_at, created_at_epoch_ms)
			 SELECT ?, ?, ?, ?, ?, ?, 'observed', ?, ?, ?, ?, ?, ?, ?, ?
			 WHERE NOT EXISTS (SELECT 1 FROM assessments WHERE run_key = ?)`,
		)
		.bind(
			id,
			input.runKey,
			input.uri,
			input.cid,
			input.artifactId ?? null,
			input.artifactChecksum ?? null,
			input.trigger,
			input.triggerId,
			input.policyVersion,
			input.modelId ?? null,
			input.promptHash ?? null,
			input.coverageJson,
			now.toISOString(),
			now.getTime(),
			input.runKey,
		)
		.run();
	const assessment = await getAssessmentByRunKey(db, input.runKey);
	if (!assessment) throw new Error("assessment run did not persist");
	return { assessment, created: assessment.id === id };
}

export async function getAssessment(db: D1Database, id: string): Promise<Assessment | null> {
	if (!ASSESSMENT_ID.test(id)) throw new TypeError("assessment id is invalid");
	const row = await db
		.prepare(
			`SELECT id, run_key, uri, cid, artifact_id, artifact_checksum, state, trigger, trigger_id,
			 policy_version, model_id, prompt_hash, public_summary, coverage_json,
			 supersedes_assessment_id, started_at, completed_at, created_at
			 FROM assessments WHERE id = ?`,
		)
		.bind(id)
		.first<AssessmentRow>();
	return row ? rowToAssessment(row) : null;
}

export async function getAssessmentByRunKey(
	db: D1Database,
	runKey: string,
): Promise<Assessment | null> {
	const row = await db
		.prepare(
			`SELECT id, run_key, uri, cid, artifact_id, artifact_checksum, state, trigger, trigger_id,
			 policy_version, model_id, prompt_hash, public_summary, coverage_json,
			 supersedes_assessment_id, started_at, completed_at, created_at
			 FROM assessments WHERE run_key = ?`,
		)
		.bind(runKey)
		.first<AssessmentRow>();
	return row ? rowToAssessment(row) : null;
}

/**
 * Non-terminal runs for a URI, regardless of CID. Used when a delete event
 * arrives: any run still in flight for a now-deleted subject is cancelled
 * (spec §9.1: "A running assessment may finish for forensic purposes but
 * must not issue a new positive label for a deleted subject" — v1 cancels
 * outright rather than letting it run to a forensic-only completion).
 */
export async function listNonTerminalAssessmentsForUri(
	db: D1Database,
	uri: string,
): Promise<Assessment[]> {
	const rows = await db
		.prepare(
			`SELECT id, run_key, uri, cid, artifact_id, artifact_checksum, state, trigger, trigger_id,
			 policy_version, model_id, prompt_hash, public_summary, coverage_json,
			 supersedes_assessment_id, started_at, completed_at, created_at
			 FROM assessments
			 WHERE uri = ? AND state NOT IN (${Array.from(TERMINAL_STATES, () => "?").join(", ")})`,
		)
		.bind(uri, ...TERMINAL_STATES)
		.all<AssessmentRow>();
	return (rows.results ?? []).map(rowToAssessment);
}

export interface TransitionAssessmentInput {
	id: string;
	from: AssessmentState;
	to: AssessmentState;
	now?: Date;
}

/**
 * CAS transition for every state change except a run's decision outcome:
 * `running` -> passed/warned/blocked/error must go through
 * `buildFinalizationStatements`, which stamps `completed_at` and — only for
 * passed/warned/blocked — moves the `current_assessments` pointer in the
 * same batch as the outcome's label statements. This function throws
 * AssessmentTransitionConflictError rather than silently no-op'ing when
 * `from` no longer matches the stored state.
 */
export async function transitionAssessmentState(
	db: D1Database,
	input: TransitionAssessmentInput,
): Promise<Assessment> {
	if (!isLegalTransition(input.from, input.to))
		throw new TypeError(`illegal assessment transition: ${input.from} -> ${input.to}`);
	if (input.from === "running" && input.to !== "stale" && input.to !== "cancelled")
		throw new TypeError(`use buildFinalizationStatements to transition running -> ${input.to}`);
	const now = input.now ?? new Date();
	const setStartedAt = input.from === "pending" && input.to === "running";
	const result = await db
		.prepare(
			setStartedAt
				? `UPDATE assessments SET state = ?, started_at = ?, started_at_epoch_ms = ?
				   WHERE id = ? AND state = ?`
				: `UPDATE assessments SET state = ? WHERE id = ? AND state = ?`,
		)
		.bind(
			...(setStartedAt
				? [input.to, now.toISOString(), now.getTime(), input.id, input.from]
				: [input.to, input.id, input.from]),
		)
		.run();
	if (result.meta.changes !== 1) {
		const current = await getAssessment(db, input.id);
		throw new AssessmentTransitionConflictError(
			input.id,
			input.from,
			input.to,
			current?.state ?? null,
		);
	}
	const assessment = await getAssessment(db, input.id);
	if (!assessment) throw new Error("assessment disappeared after a successful transition");
	return assessment;
}

export interface CurrentAssessmentPointer {
	src: string;
	uri: string;
	cid: string;
	assessmentId: string;
	updatedAt: string;
}

export async function getCurrentAssessment(
	db: D1Database,
	input: { src: string; uri: string; cid: string },
): Promise<CurrentAssessmentPointer | null> {
	const row = await db
		.prepare(
			`SELECT src, uri, cid, assessment_id, updated_at FROM current_assessments
			 WHERE src = ? AND uri = ? AND cid = ?`,
		)
		.bind(input.src, input.uri, input.cid)
		.first<{ src: string; uri: string; cid: string; assessment_id: string; updated_at: string }>();
	return row
		? {
				src: row.src,
				uri: row.uri,
				cid: row.cid,
				assessmentId: row.assessment_id,
				updatedAt: row.updated_at,
			}
		: null;
}

export interface NegatableAutomatedLabel {
	val: string;
}

/**
 * Prior automated-assessment labels still active (not yet negated) for a
 * (uri, cid), per label value. A superseding run negates whichever of these
 * it no longer supports (spec §10) — but a manually-issued label (reviewer
 * or admin action, `issuance_actions.type = 'manual-label'`) is never a
 * candidate here, so automation can never negate it (spec §10: "Automation
 * cannot negate action-backed assessment-passed/assessment-overridden
 * labels or undo a human !takedown, security-yanked, package label, or
 * publisher label").
 *
 * "Active" means the most recent automated-assessment issuance for that
 * value, ordered by `issued_labels.sequence`, is a positive (non-negated)
 * one — a value whose latest automated event is already a negation isn't
 * returned, since there's nothing left to negate.
 */
export async function getNegatableAutomatedLabels(
	db: D1Database,
	input: { src: string; uri: string; cid: string },
): Promise<NegatableAutomatedLabel[]> {
	const rows = await db
		.prepare(
			// Scoped to this labeler's own `src`: a labeler only negates labels it
			// issued (ATProto streams are per-issuer). The inner MAX reflects the
			// TRUE stream head within that src, so a val whose latest event was a
			// manual action is never returned — only a val whose current active
			// event is an automated non-negation is a candidate (§10).
			`SELECT l.val
			 FROM issued_labels l
			 JOIN issuance_actions a ON a.id = l.action_id
			 WHERE l.src = ? AND l.uri = ? AND l.cid = ? AND a.type = 'automated-assessment' AND l.neg = 0
			 AND l.sequence = (
				SELECT MAX(l2.sequence) FROM issued_labels l2
				WHERE l2.src = l.src AND l2.uri = l.uri AND l2.cid = l.cid AND l2.val = l.val
			 )`,
		)
		.bind(input.src, input.uri, input.cid)
		.all<{ val: string }>();
	return (rows.results ?? []).map((row) => ({ val: row.val }));
}

export interface FinalizationInput {
	assessmentId: string;
	fromState: AssessmentState;
	toState: AssessmentState;
	src: string;
	uri: string;
	cid: string;
	now?: Date;
	publicSummary?: string;
	coverageJson?: string;
	supersedesAssessmentId?: string;
}

export interface FinalizationStatements {
	statements: D1PreparedStatement[];
	/** Index into `statements` of the CAS update; `changes !== 1` means the finalization lost its race. */
	assessmentUpdateIndex: number;
	/** Index of the `current_assessments` upsert, when `toState` moves the pointer. */
	pointerUpdateIndex: number | null;
}

/**
 * Builds the statements that complete an assessment run: the CAS transition
 * out of `running`, and — only for passed/warned/blocked — the
 * `current_assessments` pointer update in the same batch (spec §10). The
 * caller (PR B) concatenates these with N label-issuance statements from
 * `buildIssuanceStatements` into one `db.batch`.
 */
export function buildFinalizationStatements(
	db: D1Database,
	input: FinalizationInput,
): FinalizationStatements {
	if (!isLegalTransition(input.fromState, input.toState))
		throw new TypeError(`illegal assessment transition: ${input.fromState} -> ${input.toState}`);
	if (!DECISION_OUTCOME_STATES.has(input.toState))
		throw new TypeError(
			`buildFinalizationStatements is for decision outcomes; use transitionAssessmentState for ${input.toState}`,
		);
	const now = (input.now ?? new Date()).toISOString();
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`UPDATE assessments
				 SET state = ?, completed_at = ?, completed_at_epoch_ms = ?,
				     public_summary = COALESCE(?, public_summary),
				     coverage_json = COALESCE(?, coverage_json),
				     supersedes_assessment_id = COALESCE(?, supersedes_assessment_id)
				 WHERE id = ? AND state = ?`,
			)
			.bind(
				input.toState,
				now,
				Date.parse(now),
				input.publicSummary ?? null,
				input.coverageJson ?? null,
				input.supersedesAssessmentId ?? null,
				input.assessmentId,
				input.fromState,
			),
	];
	let pointerUpdateIndex: number | null = null;
	if (CURRENT_POINTER_STATES.has(input.toState)) {
		pointerUpdateIndex = statements.length;
		statements.push(
			db
				.prepare(
					`INSERT INTO current_assessments (src, uri, cid, assessment_id, updated_at)
					 SELECT ?, ?, ?, ?, ?
					 WHERE EXISTS (SELECT 1 FROM assessments WHERE id = ? AND state = ?)
					 ON CONFLICT(src, uri, cid) DO UPDATE SET
					   assessment_id = excluded.assessment_id, updated_at = excluded.updated_at
					 WHERE EXISTS (SELECT 1 FROM assessments WHERE id = ? AND state = ?)
					   AND (SELECT created_at_epoch_ms FROM assessments WHERE id = excluded.assessment_id)
					       >= (SELECT created_at_epoch_ms FROM assessments WHERE id = current_assessments.assessment_id)`,
				)
				.bind(
					input.src,
					input.uri,
					input.cid,
					input.assessmentId,
					now,
					input.assessmentId,
					input.toState,
					input.assessmentId,
					input.toState,
				),
		);
	}
	return { statements, assessmentUpdateIndex: 0, pointerUpdateIndex };
}

export interface RecordFindingInput {
	assessmentId: string;
	source: string;
	category: string;
	severity: "critical" | "high" | "medium" | "low" | "info";
	confidence?: number;
	title: string;
	publicSummary: string;
	privateDetail: string;
	evidenceRefs: readonly string[];
	now?: Date;
}

export async function recordFinding(db: D1Database, input: RecordFindingInput): Promise<string> {
	const id = `find_${ulid()}`;
	const now = input.now ?? new Date();
	await db
		.prepare(
			`INSERT INTO findings
			 (id, assessment_id, source, category, severity, confidence, title, public_summary,
			  private_detail, evidence_refs_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			input.assessmentId,
			input.source,
			input.category,
			input.severity,
			input.confidence ?? null,
			input.title,
			input.publicSummary,
			input.privateDetail,
			JSON.stringify(input.evidenceRefs),
			now.toISOString(),
		)
		.run();
	return id;
}

export interface RecordEvidenceObjectInput {
	assessmentId: string;
	kind: string;
	sha256: string;
	r2Key?: string;
	metadata: Record<string, unknown>;
	now?: Date;
}

export async function recordEvidenceObject(
	db: D1Database,
	input: RecordEvidenceObjectInput,
): Promise<string> {
	const id = `evid_${ulid()}`;
	const now = input.now ?? new Date();
	await db
		.prepare(
			`INSERT INTO evidence_objects (id, assessment_id, kind, sha256, r2_key, metadata_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			input.assessmentId,
			input.kind,
			input.sha256,
			input.r2Key ?? null,
			JSON.stringify(input.metadata),
			now.toISOString(),
		)
		.run();
	return id;
}

/** A newer completed run whose `supersedes_assessment_id` names `assessmentId`
 * and currently owns the subject's pointer. This is the back-pointer +
 * pointer-ownership rule (spec §480/§718) — a row is never superseded merely
 * for not being the current pointer. */
export async function isSuperseded(db: D1Database, assessmentId: string): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 FROM assessments a
			 JOIN current_assessments c ON c.assessment_id = a.id
			 WHERE a.supersedes_assessment_id = ?
			 LIMIT 1`,
		)
		.bind(assessmentId)
		.first();
	return row !== null;
}

export interface ListAssessmentsFilters {
	uri?: string;
	cid?: string;
	state?: PublicAssessmentState;
}

export interface AssessmentKeyset {
	createdAt: string;
	id: string;
}

export interface ListedAssessment extends Assessment {
	isSuperseded: boolean;
}

const SUPERSEDED_EXISTS_SQL = `EXISTS (
	SELECT 1 FROM assessments b
	JOIN current_assessments c ON c.assessment_id = b.id
	WHERE b.supersedes_assessment_id = a.id
)`;

const DECISION_PUBLIC_STATES: ReadonlySet<PublicAssessmentState> = new Set([
	"passed",
	"warned",
	"blocked",
	"error",
]);

const STORED_STATES_BY_PUBLIC_STATE: Readonly<
	Record<Exclude<PublicAssessmentState, "superseded">, readonly AssessmentState[]>
> = {
	pending: ["pending", "running"],
	passed: ["passed"],
	warned: ["warned"],
	blocked: ["blocked"],
	error: ["error"],
};

/** Keeps `IN (?, ?, …)` clauses well within D1's bound-parameter limit. */
const LABEL_QUERY_BATCH_SIZE = 90;

/**
 * Public listing page, newest first, exclusive keyset on
 * `(created_at_epoch_ms, id)`. `isSuperseded` is computed inline via the same
 * correlated subquery as `isSuperseded` above rather than a follow-up query
 * per row — every row in a page needs it, not just one.
 */
export async function getAssessmentsPage(
	db: D1Database,
	filters: ListAssessmentsFilters,
	keyset: AssessmentKeyset | null,
	limit: number,
): Promise<ListedAssessment[]> {
	const conditions = [`a.state NOT IN ('observed', 'verifying', 'stale', 'cancelled')`];
	const bindings: (string | number)[] = [];

	if (filters.state === "superseded") {
		conditions.push(`a.state IN ('passed', 'warned', 'blocked', 'error')`);
		conditions.push(SUPERSEDED_EXISTS_SQL);
	} else if (filters.state !== undefined) {
		const stored = STORED_STATES_BY_PUBLIC_STATE[filters.state];
		conditions.push(`a.state IN (${stored.map(() => "?").join(", ")})`);
		bindings.push(...stored);
		if (DECISION_PUBLIC_STATES.has(filters.state)) conditions.push(`NOT ${SUPERSEDED_EXISTS_SQL}`);
	}
	if (filters.uri !== undefined) {
		conditions.push(`a.uri = ?`);
		bindings.push(filters.uri);
	}
	if (filters.cid !== undefined) {
		conditions.push(`a.cid = ?`);
		bindings.push(filters.cid);
	}
	if (keyset !== null) {
		const epochMs = Date.parse(keyset.createdAt);
		conditions.push(`(a.created_at_epoch_ms < ? OR (a.created_at_epoch_ms = ? AND a.id < ?))`);
		bindings.push(epochMs, epochMs, keyset.id);
	}
	// Fetch limit+1 so the caller can detect a next page without a trailing
	// COUNT query — the caller is responsible for slicing back to `limit`.
	bindings.push(limit + 1);

	const rows = await db
		.prepare(
			`SELECT a.id, a.run_key, a.uri, a.cid, a.artifact_id, a.artifact_checksum, a.state,
			 a.trigger, a.trigger_id, a.policy_version, a.model_id, a.prompt_hash,
			 a.public_summary, a.coverage_json, a.supersedes_assessment_id,
			 a.started_at, a.completed_at, a.created_at,
			 ${SUPERSEDED_EXISTS_SQL} AS is_superseded
			 FROM assessments a
			 WHERE ${conditions.join(" AND ")}
			 ORDER BY a.created_at_epoch_ms DESC, a.id DESC
			 LIMIT ?`,
		)
		.bind(...bindings)
		.all<AssessmentRow & { is_superseded: number }>();
	return (rows.results ?? []).map((row) => ({
		...rowToAssessment(row),
		isSuperseded: row.is_superseded === 1,
	}));
}

export interface AssessmentLabelOp {
	val: string;
	cts: string;
	exp: string | null;
	sequence: number;
}

/** Positive label ops issued by one assessment (D5) — joined off
 * `issuance_actions.assessment_id`, excluding negations (a `neg=true` op is a
 * retraction, not a label to display). */
export async function getLabelsForAssessment(
	db: D1Database,
	assessmentId: string,
): Promise<AssessmentLabelOp[]> {
	const rows = await db
		.prepare(
			`SELECT l.val, l.cts, l.exp, l.sequence
			 FROM issued_labels l
			 JOIN issuance_actions a ON a.id = l.action_id
			 WHERE a.assessment_id = ? AND l.neg = 0
			 ORDER BY l.sequence ASC`,
		)
		.bind(assessmentId)
		.all<AssessmentLabelOp>();
	return rows.results ?? [];
}

/** Batched form of {@link getLabelsForAssessment} for a page of assessments
 * (D5) — one query per {@link LABEL_QUERY_BATCH_SIZE}-sized chunk of ids
 * instead of one query per row, so a list page's label lookups stay
 * independent of page size. */
export async function getLabelsForAssessments(
	db: D1Database,
	assessmentIds: readonly string[],
): Promise<Map<string, AssessmentLabelOp[]>> {
	const byAssessment = new Map<string, AssessmentLabelOp[]>();
	for (let offset = 0; offset < assessmentIds.length; offset += LABEL_QUERY_BATCH_SIZE) {
		const chunk = assessmentIds.slice(offset, offset + LABEL_QUERY_BATCH_SIZE);
		const rows = await db
			.prepare(
				`SELECT a.assessment_id, l.val, l.cts, l.exp, l.sequence
				 FROM issued_labels l
				 JOIN issuance_actions a ON a.id = l.action_id
				 WHERE a.assessment_id IN (${chunk.map(() => "?").join(", ")}) AND l.neg = 0
				 ORDER BY l.sequence ASC`,
			)
			.bind(...chunk)
			.all<AssessmentLabelOp & { assessment_id: string }>();
		for (const row of rows.results ?? []) {
			const op: AssessmentLabelOp = {
				val: row.val,
				cts: row.cts,
				exp: row.exp,
				sequence: row.sequence,
			};
			const ops = byAssessment.get(row.assessment_id);
			if (ops) ops.push(op);
			else byAssessment.set(row.assessment_id, [op]);
		}
	}
	return byAssessment;
}

export interface LabelStreamWinner {
	val: string;
	cid: string | null;
	cts: string;
	exp: string | null;
	sequence: number;
	active: boolean;
}

/**
 * Latest event per `val` in the `(src, uri)` stream across all CIDs — the
 * highest-`sequence` `issued_labels` row for that `val`, regardless of its
 * own `cid`. `sequence` is a strictly monotonic counter assigned at insert
 * time (migration 0002's trigger), independent of `cts`, so ordering by it
 * is also the correct cts-collision tiebreak.
 *
 * CID applicability is applied to the winner, not before reduction: a
 * winner is `active` only when it is non-negated, unexpired, and either
 * URI-wide (`cid` NULL) or bound to the queried `cid` — matching the
 * aggregator's canonical `label_state` reduction (`PRIMARY KEY (src, uri,
 * val)`, CID excluded from the key) and its `hydrateLabels` post-reduction
 * applicability check. A newer CID-bound event therefore retracts an older
 * URI-wide event for the same `val`, and a CID-mismatched event still wins
 * the reduction (reporting `active: false`) rather than being invisible to
 * it. Shared by both `labels[].active` (per-assessment) and `activeLabels`
 * (getCurrentAssessment) so the two never diverge.
 */
export async function getActiveLabelState(
	db: D1Database,
	input: { src: string; uri: string; cid: string; now?: Date },
): Promise<Map<string, LabelStreamWinner>> {
	const now = input.now ?? new Date();
	const rows = await db
		.prepare(
			`SELECT val, neg, cid, cts, exp, sequence
			 FROM issued_labels
			 WHERE src = ? AND uri = ?
			 ORDER BY sequence ASC`,
		)
		.bind(input.src, input.uri)
		.all<{
			val: string;
			neg: number;
			cid: string | null;
			cts: string;
			exp: string | null;
			sequence: number;
		}>();
	const winners = new Map<string, LabelStreamWinner>();
	for (const row of rows.results ?? []) {
		const applicable = row.cid === null || row.cid === input.cid;
		const active =
			row.neg === 0 && applicable && (row.exp === null || Date.parse(row.exp) > now.getTime());
		winners.set(row.val, {
			val: row.val,
			cid: row.cid,
			cts: row.cts,
			exp: row.exp,
			sequence: row.sequence,
			active,
		});
	}
	return winners;
}

/** The newest in-flight run (`pending` or `running`) for a subject — the
 * `pending` field of `getCurrentAssessment`'s view, when it isn't the run
 * that already owns the current pointer (a decision-outcome state, so the
 * two state sets never overlap). */
export async function getLatestPendingAssessment(
	db: D1Database,
	input: { uri: string; cid: string },
): Promise<Assessment | null> {
	const row = await db
		.prepare(
			`SELECT id, run_key, uri, cid, artifact_id, artifact_checksum, state, trigger, trigger_id,
			 policy_version, model_id, prompt_hash, public_summary, coverage_json,
			 supersedes_assessment_id, started_at, completed_at, created_at
			 FROM assessments
			 WHERE uri = ? AND cid = ? AND state IN ('pending', 'running')
			 ORDER BY created_at_epoch_ms DESC, id DESC
			 LIMIT 1`,
		)
		.bind(input.uri, input.cid)
		.first<AssessmentRow>();
	return row ? rowToAssessment(row) : null;
}

/** Whether verification ever recorded this (uri, cid) subject, regardless of
 * subsequent deletion — used to distinguish "never seen" (NotFound) from "seen
 * but has no current/pending run or active label" (an empty-but-200 view). */
export async function subjectWasObserved(
	db: D1Database,
	input: { uri: string; cid: string },
): Promise<boolean> {
	const row = await db
		.prepare(`SELECT 1 FROM subjects WHERE uri = ? AND cid = ? LIMIT 1`)
		.bind(input.uri, input.cid)
		.first();
	return row !== null;
}

function rowToAssessment(row: AssessmentRow): Assessment {
	return {
		id: row.id,
		runKey: row.run_key,
		uri: row.uri,
		cid: row.cid,
		artifactId: row.artifact_id,
		artifactChecksum: row.artifact_checksum,
		state: row.state,
		trigger: row.trigger,
		triggerId: row.trigger_id,
		policyVersion: row.policy_version,
		modelId: row.model_id,
		promptHash: row.prompt_hash,
		publicSummary: row.public_summary,
		coverageJson: row.coverage_json,
		supersedesAssessmentId: row.supersedes_assessment_id,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		createdAt: row.created_at,
	};
}
