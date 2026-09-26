import { parseSubjectUri, workflowParamsToIdentity } from "./run-key.js";
import type {
	AssessmentRunSnapshot,
	AssessmentRunState,
	AssessmentWorkflowParams,
} from "./types.js";

const MAX_CANONICAL_INPUT_BYTES = 256 * 1024;
const OPERATIONAL_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

export interface ObserveAssessmentRunOptions {
	params: AssessmentWorkflowParams;
	observedAt: string;
	makeCurrent?: boolean;
}

export interface PreparedAssessmentData {
	moderationFingerprint: string;
	canonicalInput: unknown;
	coverage: unknown;
}

export interface AssessmentLifecycleStore {
	observeRun(options: ObserveAssessmentRunOptions): Promise<AssessmentRunSnapshot>;
	getRun(runKey: string): Promise<AssessmentRunSnapshot | null>;
	startRun(runKey: string, expectedVersion: number, now: string): Promise<AssessmentRunSnapshot>;
	persistPrepared(
		runKey: string,
		expectedVersion: number,
		data: PreparedAssessmentData,
		now: string,
	): Promise<AssessmentRunSnapshot>;
	finalizeRun(
		runKey: string,
		expectedVersion: number,
		outcome: "passed" | "review" | "error",
		now: string,
	): Promise<AssessmentRunSnapshot>;
	failRun?(
		runKey: string,
		expectedVersion: number,
		errorCode: string,
		now: string,
	): Promise<AssessmentRunSnapshot>;
	cancelSubject(uri: string, now: string): Promise<void>;
}

export function createD1AssessmentLifecycleStore(db: D1Database): AssessmentLifecycleStore {
	return {
		async observeRun({ params, observedAt, makeCurrent = true }) {
			const identity = workflowParamsToIdentity(params);
			const { publisherDid } = parseSubjectUri(identity.subject.uri);
			const statements = [
				db
					.prepare(
						`INSERT INTO subjects
						   (uri, cid, kind, publisher_did, first_observed_at, last_observed_at, deleted_at)
						 VALUES (?, ?, ?, ?, ?, ?, NULL)
						 ON CONFLICT(uri, cid) DO UPDATE SET
						   last_observed_at = excluded.last_observed_at,
						   deleted_at = NULL`,
					)
					.bind(
						identity.subject.uri,
						identity.subject.cid,
						identity.subject.kind,
						publisherDid,
						observedAt,
						observedAt,
					),
				db
					.prepare(
						`INSERT INTO assessments
						   (id, run_key, subject_uri, subject_cid, subject_kind,
						    policy_version, parser_version, text_model_id, text_prompt_hash,
						    image_model_id, image_prompt_hash, logical_trigger_id,
						    state, state_version, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
						 ON CONFLICT(run_key) DO NOTHING`,
					)
					.bind(
						params.runKey,
						params.runKey,
						identity.subject.uri,
						identity.subject.cid,
						identity.subject.kind,
						identity.versions.policyVersion,
						identity.versions.parserVersion,
						identity.versions.textModelId,
						identity.versions.textPromptHash,
						identity.versions.imageModelId,
						identity.versions.imagePromptHash,
						identity.logicalTriggerId,
						observedAt,
						observedAt,
					),
				db
					.prepare(
						`INSERT INTO current_assessments
						   (subject_uri, subject_cid, assessment_id, updated_at)
						 VALUES (?, ?, ?, ?)
						 ON CONFLICT(subject_uri, subject_cid) DO UPDATE SET
						   assessment_id = excluded.assessment_id,
						   updated_at = excluded.updated_at`,
					)
					.bind(identity.subject.uri, identity.subject.cid, params.runKey, observedAt),
			];
			if (makeCurrent) {
				statements.splice(
					1,
					0,
					db
						.prepare(
							`INSERT INTO current_subjects (uri, cid, kind, updated_at, deleted_at)
							 VALUES (?, ?, ?, ?, NULL)
							 ON CONFLICT(uri) DO UPDATE SET
							   cid = excluded.cid,
							   kind = excluded.kind,
							   updated_at = excluded.updated_at,
							   deleted_at = NULL`,
						)
						.bind(identity.subject.uri, identity.subject.cid, identity.subject.kind, observedAt),
				);
			}
			await db.batch(statements);
			const snapshot = await readRun(db, params.runKey);
			if (!snapshot) throw new Error("assessment run was not durably observed");
			if (
				snapshot.subject.uri !== identity.subject.uri ||
				snapshot.subject.cid !== identity.subject.cid ||
				snapshot.subject.kind !== identity.subject.kind
			) {
				throw new Error("assessment run key is already bound to different inputs");
			}
			return snapshot;
		},
		getRun(runKey) {
			return readRun(db, runKey);
		},
		async startRun(runKey, expectedVersion, now) {
			try {
				return await transitionRun(db, runKey, "pending", expectedVersion, "running", now, {
					startedAt: now,
				});
			} catch (error) {
				if (!(error instanceof AssessmentStateConflictError)) throw error;
				const current = await readRun(db, runKey);
				if (current?.state === "running" && current.stateVersion === expectedVersion + 1) {
					return current;
				}
				throw error;
			}
		},
		async persistPrepared(runKey, expectedVersion, data, now) {
			const canonicalInputJson = JSON.stringify(data.canonicalInput);
			if (new TextEncoder().encode(canonicalInputJson).byteLength > MAX_CANONICAL_INPUT_BYTES) {
				throw new RangeError("canonical assessment input exceeds its storage limit");
			}
			const result = await db
				.prepare(
					`UPDATE assessments SET
					   state_version = state_version + 1,
					   moderation_fingerprint = ?,
					   coverage_json = ?,
					   canonical_input_json = ?,
					   updated_at = ?
					 WHERE run_key = ? AND state = 'running' AND state_version = ?
					   AND EXISTS (
					     SELECT 1
					     FROM current_subjects c
					     JOIN subjects s ON s.uri = c.uri AND s.cid = c.cid
					     WHERE c.uri = assessments.subject_uri
					       AND c.cid = assessments.subject_cid
					       AND c.deleted_at IS NULL
					       AND s.deleted_at IS NULL
					   )`,
				)
				.bind(
					data.moderationFingerprint,
					JSON.stringify(data.coverage),
					canonicalInputJson,
					now,
					runKey,
					expectedVersion,
				)
				.run();
			if (result.meta.changes !== 1) {
				const eligibility = await readEligibility(db, runKey);
				if (!eligibility) throw new Error("assessment run does not exist");
				if (eligibility.state === "cancelled") return eligibility.snapshot;
				if (
					eligibility.state === "running" &&
					eligibility.stateVersion === expectedVersion &&
					!eligibility.current
				) {
					return transitionRun(
						db,
						runKey,
						"running",
						expectedVersion,
						eligibility.deleted ? "cancelled" : "superseded",
						now,
						eligibility.deleted ? { cancelledAt: now } : { completedAt: now },
					);
				}
				const existing = await db
					.prepare(
						`SELECT state, state_version, moderation_fingerprint
						 FROM assessments WHERE run_key = ?`,
					)
					.bind(runKey)
					.first<{
						state: AssessmentRunState;
						state_version: number;
						moderation_fingerprint: string | null;
					}>();
				if (
					existing?.state !== "running" ||
					existing.state_version !== expectedVersion + 1 ||
					existing.moderation_fingerprint !== data.moderationFingerprint
				) {
					throw new AssessmentStateConflictError(runKey);
				}
			}
			const snapshot = await readRun(db, runKey);
			if (!snapshot) throw new Error("assessment run disappeared after preparation");
			return snapshot;
		},
		async finalizeRun(runKey, expectedVersion, outcome, now) {
			const result = await db
				.prepare(
					`UPDATE assessments SET
					   state = ?,
					   state_version = state_version + 1,
					   updated_at = ?,
					   completed_at = ?
					 WHERE run_key = ? AND state = 'running' AND state_version = ?
					   AND moderation_fingerprint IS NOT NULL
					   AND EXISTS (
					     SELECT 1
					     FROM current_subjects c
					     JOIN subjects s ON s.uri = c.uri AND s.cid = c.cid
					     WHERE c.uri = assessments.subject_uri
					       AND c.cid = assessments.subject_cid
					       AND c.deleted_at IS NULL
					       AND s.deleted_at IS NULL
					   )`,
				)
				.bind(outcome, now, now, runKey, expectedVersion)
				.run();
			if (result.meta.changes !== 1) {
				const existing = await readRun(db, runKey);
				if (existing?.state === outcome && existing.stateVersion === expectedVersion + 1) {
					return existing;
				}
				throw new AssessmentStateConflictError(runKey);
			}
			const snapshot = await readRun(db, runKey);
			if (!snapshot) throw new Error("assessment run disappeared after finalization");
			return snapshot;
		},
		async failRun(runKey, expectedVersion, errorCode, now) {
			if (!OPERATIONAL_ERROR_CODE_RE.test(errorCode)) {
				throw new TypeError("assessment operational error code is invalid");
			}
			const result = await db
				.prepare(
					`UPDATE assessments SET
					   state = 'error',
					   state_version = state_version + 1,
					   error_code = ?,
					   updated_at = ?,
					   completed_at = ?
					 WHERE run_key = ? AND state = 'running' AND state_version = ?`,
				)
				.bind(errorCode, now, now, runKey, expectedVersion)
				.run();
			if (result.meta.changes !== 1) {
				const existing = await readRun(db, runKey);
				if (existing?.state === "error" && existing.stateVersion === expectedVersion + 1) {
					return existing;
				}
				throw new AssessmentStateConflictError(runKey);
			}
			const snapshot = await readRun(db, runKey);
			if (!snapshot) throw new Error("assessment run disappeared after operational failure");
			return snapshot;
		},
		async cancelSubject(uri, now) {
			await db.batch([
				db
					.prepare(`UPDATE subjects SET deleted_at = ?, last_observed_at = ? WHERE uri = ?`)
					.bind(now, now, uri),
				db
					.prepare(`UPDATE current_subjects SET deleted_at = ?, updated_at = ? WHERE uri = ?`)
					.bind(now, now, uri),
				db
					.prepare(
						`UPDATE assessments SET
						   state = 'cancelled',
						   state_version = state_version + 1,
						   cancelled_at = ?,
						   updated_at = ?
						 WHERE subject_uri = ? AND state IN ('pending', 'running')`,
					)
					.bind(now, now, uri),
			]);
		},
	};
}

async function readEligibility(
	db: D1Database,
	runKey: string,
): Promise<{
	state: AssessmentRunState;
	stateVersion: number;
	current: boolean;
	deleted: boolean;
	snapshot: AssessmentRunSnapshot;
} | null> {
	const row = await db
		.prepare(
			`SELECT a.state, a.state_version,
			        c.cid AS current_cid, c.deleted_at AS current_deleted_at,
			        s.deleted_at AS subject_deleted_at
			 FROM assessments a
			 JOIN subjects s ON s.uri = a.subject_uri AND s.cid = a.subject_cid
			 LEFT JOIN current_subjects c ON c.uri = a.subject_uri
			 WHERE a.run_key = ?`,
		)
		.bind(runKey)
		.first<{
			state: AssessmentRunState;
			state_version: number;
			current_cid: string | null;
			current_deleted_at: string | null;
			subject_deleted_at: string | null;
		}>();
	if (!row) return null;
	const snapshot = await readRun(db, runKey);
	if (!snapshot) return null;
	const deleted = row.current_deleted_at !== null || row.subject_deleted_at !== null;
	return {
		state: row.state,
		stateVersion: row.state_version,
		current: !deleted && row.current_cid === snapshot.subject.cid,
		deleted,
		snapshot,
	};
}

export class AssessmentStateConflictError extends Error {
	override readonly name = "AssessmentStateConflictError";
	constructor(readonly runKey: string) {
		super(`assessment run ${runKey} changed concurrently`);
	}
}

interface AssessmentRow {
	run_key: string;
	subject_uri: string;
	subject_cid: string;
	subject_kind: "profile" | "release";
	state: AssessmentRunState;
	state_version: number;
	deleted_at: string | null;
}

async function readRun(db: D1Database, runKey: string): Promise<AssessmentRunSnapshot | null> {
	const row = await db
		.prepare(
			`SELECT a.run_key, a.subject_uri, a.subject_cid, a.subject_kind,
			        a.state, a.state_version, s.deleted_at
			 FROM assessments a
			 JOIN subjects s ON s.uri = a.subject_uri AND s.cid = a.subject_cid
			 WHERE a.run_key = ?`,
		)
		.bind(runKey)
		.first<AssessmentRow>();
	return row
		? {
				runKey: row.run_key,
				subject: { uri: row.subject_uri, cid: row.subject_cid, kind: row.subject_kind },
				state: row.state,
				stateVersion: row.state_version,
				deleted: row.deleted_at !== null,
			}
		: null;
}

async function transitionRun(
	db: D1Database,
	runKey: string,
	from: AssessmentRunState,
	expectedVersion: number,
	to: AssessmentRunState,
	now: string,
	timestamps: { startedAt?: string; completedAt?: string; cancelledAt?: string },
): Promise<AssessmentRunSnapshot> {
	const result = await db
		.prepare(
			`UPDATE assessments SET
			   state = ?,
			   state_version = state_version + 1,
			   updated_at = ?,
			   started_at = COALESCE(?, started_at),
			   completed_at = COALESCE(?, completed_at),
			   cancelled_at = COALESCE(?, cancelled_at)
			 WHERE run_key = ? AND state = ? AND state_version = ?`,
		)
		.bind(
			to,
			now,
			timestamps.startedAt ?? null,
			timestamps.completedAt ?? null,
			timestamps.cancelledAt ?? null,
			runKey,
			from,
			expectedVersion,
		)
		.run();
	if (result.meta.changes !== 1) throw new AssessmentStateConflictError(runKey);
	const snapshot = await readRun(db, runKey);
	if (!snapshot) throw new Error("assessment run disappeared after transition");
	return snapshot;
}
