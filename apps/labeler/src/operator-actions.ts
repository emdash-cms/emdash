import type { OperatorRole } from "./access-auth.js";

/**
 * The operator-action vocabulary, grown by W9.4–W9.6. Validated in app code
 * (the guard is the only writer), so the `operator_actions.action` column
 * carries no SQL CHECK and each workstream stays purely additive.
 */
export type OperatorActionType =
	| "label-issue"
	| "label-retract"
	| "assessment-rerun"
	| "unblock-override"
	| "override-retract"
	| "takedown"
	| "publisher-compromised"
	| "pause-issuance"
	| "resume-issuance"
	| "dlq-retry"
	| "dlq-quarantine";

export interface StoredOperatorAction {
	id: string;
	actorType: "human" | "service";
	actorId: string;
	actorEmail: string | null;
	actorCommonName: string | null;
	role: OperatorRole;
	action: string;
	subjectUri: string | null;
	subjectCid: string | null;
	labelValue: string | null;
	reason: string;
	idempotencyKey: string;
	requestFingerprint: string;
	resultJson: string | null;
	metadataJson: string;
	createdAt: string;
	createdAtEpochMs: number;
}

interface OperatorActionRow {
	id: string;
	actor_type: "human" | "service";
	actor_id: string;
	actor_email: string | null;
	actor_common_name: string | null;
	role: OperatorRole;
	action: string;
	subject_uri: string | null;
	subject_cid: string | null;
	label_value: string | null;
	reason: string;
	idempotency_key: string;
	request_fingerprint: string;
	result_json: string | null;
	metadata_json: string;
	created_at: string;
	created_at_epoch_ms: number;
}

export interface OperatorActionInsert {
	id: string;
	actorType: "human" | "service";
	actorId: string;
	actorEmail: string | null;
	actorCommonName: string | null;
	role: OperatorRole;
	action: OperatorActionType;
	subjectUri: string | null;
	subjectCid: string | null;
	labelValue: string | null;
	reason: string;
	idempotencyKey: string;
	requestFingerprint: string;
	resultJson: string | null;
	metadataJson: string;
	createdAt: string;
	createdAtEpochMs: number;
}

/**
 * Insert for one audit row. A duplicate `idempotency_key` raises a UNIQUE
 * violation that aborts the enclosing `db.batch`, rolling its effect statements
 * back with it — so a request that loses the key race cannot commit a side
 * effect. `commitMutation` catches that violation (see `isIdempotencyKeyConflict`)
 * and reads the winning row back to resolve replay vs conflict. Batched with its
 * effect statements; never run alone.
 */
export function buildOperatorActionInsert(
	db: D1Database,
	input: OperatorActionInsert,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO operator_actions
			 (id, actor_type, actor_id, actor_email, actor_common_name, role, action,
			  subject_uri, subject_cid, label_value, reason, idempotency_key,
			  request_fingerprint, result_json, metadata_json, created_at, created_at_epoch_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.actorType,
			input.actorId,
			input.actorEmail,
			input.actorCommonName,
			input.role,
			input.action,
			input.subjectUri,
			input.subjectCid,
			input.labelValue,
			input.reason,
			input.idempotencyKey,
			input.requestFingerprint,
			input.resultJson,
			input.metadataJson,
			input.createdAt,
			input.createdAtEpochMs,
		);
}

export async function getOperatorActionByKey(
	db: D1Database,
	idempotencyKey: string,
): Promise<StoredOperatorAction | null> {
	const row = await db
		.prepare(
			`SELECT id, actor_type, actor_id, actor_email, actor_common_name, role, action,
			 subject_uri, subject_cid, label_value, reason, idempotency_key,
			 request_fingerprint, result_json, metadata_json, created_at, created_at_epoch_ms
			 FROM operator_actions WHERE idempotency_key = ?`,
		)
		.bind(idempotencyKey)
		.first<OperatorActionRow>();
	return row ? rowToStoredOperatorAction(row) : null;
}

/** Read one audit row by its `operator_actions.id` primary key — the
 * notification subsystem's polymorphic `source_id` for an operator-triggered
 * notice, re-read by the retry sweep to rebuild the notice from source. */
export async function getOperatorActionById(
	db: D1Database,
	id: string,
): Promise<StoredOperatorAction | null> {
	const row = await db
		.prepare(
			`SELECT id, actor_type, actor_id, actor_email, actor_common_name, role, action,
			 subject_uri, subject_cid, label_value, reason, idempotency_key,
			 request_fingerprint, result_json, metadata_json, created_at, created_at_epoch_ms
			 FROM operator_actions WHERE id = ?`,
		)
		.bind(id)
		.first<OperatorActionRow>();
	return row ? rowToStoredOperatorAction(row) : null;
}

/**
 * Audit-log page, newest first, exclusive keyset on `(created_at_epoch_ms, id)`
 * over `idx_operator_actions_created`. `keyset.createdAt` is the ISO timestamp
 * carried in the opaque cursor; the epoch comparison derives from it via
 * `Date.parse`, matching `getAssessmentsPage`. Fetches `limit + 1` so the caller
 * detects a next page without a trailing COUNT.
 */
export async function getOperatorActionsPage(
	db: D1Database,
	keyset: { createdAt: string; id: string } | null,
	limit: number,
): Promise<StoredOperatorAction[]> {
	const bindings: (string | number)[] = [];
	let where = "";
	if (keyset !== null) {
		const epochMs = Date.parse(keyset.createdAt);
		where = `WHERE (created_at_epoch_ms < ? OR (created_at_epoch_ms = ? AND id < ?))`;
		bindings.push(epochMs, epochMs, keyset.id);
	}
	bindings.push(limit + 1);
	const rows = await db
		.prepare(
			`SELECT id, actor_type, actor_id, actor_email, actor_common_name, role, action,
			 subject_uri, subject_cid, label_value, reason, idempotency_key,
			 request_fingerprint, result_json, metadata_json, created_at, created_at_epoch_ms
			 FROM operator_actions ${where}
			 ORDER BY created_at_epoch_ms DESC, id DESC
			 LIMIT ?`,
		)
		.bind(...bindings)
		.all<OperatorActionRow>();
	return (rows.results ?? []).map(rowToStoredOperatorAction);
}

/**
 * True when `error` is the D1 UNIQUE violation on `operator_actions.idempotency_key`.
 * Matches the qualified column so it does not catch the `id` primary-key conflict
 * or any other constraint — `commitMutation` uses it to tell a duplicate-key race
 * (recoverable via read-back) apart from a genuine failure it must rethrow.
 */
export function isIdempotencyKeyConflict(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes("UNIQUE constraint failed: operator_actions.idempotency_key")
	);
}

/**
 * Request fingerprint: SHA-256 hex over canonical JSON (recursively sorted
 * object keys) of `{ action, ...normalizedBody }` with `idempotencyKey`
 * removed. Two requests replaying the same idempotency key must produce the
 * same fingerprint; any material difference (reason, subject, label, endpoint
 * fields) yields a different one and the guard reports a conflict.
 */
export async function computeRequestFingerprint(
	action: OperatorActionType,
	normalizedBody: Record<string, unknown>,
): Promise<string> {
	const material: Record<string, unknown> = { action };
	for (const [key, value] of Object.entries(normalizedBody)) {
		if (key === "idempotencyKey") continue;
		material[key] = value;
	}
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonicalize(material)),
	);
	return toHex(new Uint8Array(digest));
}

function canonicalize(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	const entries = Object.entries(value)
		.filter(([, v]) => v !== undefined)
		.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rowToStoredOperatorAction(row: OperatorActionRow): StoredOperatorAction {
	return {
		id: row.id,
		actorType: row.actor_type,
		actorId: row.actor_id,
		actorEmail: row.actor_email,
		actorCommonName: row.actor_common_name,
		role: row.role,
		action: row.action,
		subjectUri: row.subject_uri,
		subjectCid: row.subject_cid,
		labelValue: row.label_value,
		reason: row.reason,
		idempotencyKey: row.idempotency_key,
		requestFingerprint: row.request_fingerprint,
		resultJson: row.result_json,
		metadataJson: row.metadata_json,
		createdAt: row.created_at,
		createdAtEpochMs: row.created_at_epoch_ms,
	};
}
