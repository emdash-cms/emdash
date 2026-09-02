const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]{0,127}$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const ACTOR_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_WORKLOAD_JSON_CHARS = 16 * 1024;
const MAX_RELEASE_INPUT_JSON_CHARS = 64 * 1024;
const MAX_STATE_DATA_JSON_CHARS = 64 * 1024;
const MAX_INTENT_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const MAX_LIST_LIMIT = 101;

export type IntentState =
	| "received"
	| "verifying"
	| "verified"
	| "awaiting_approval"
	| "ready"
	| "publishing"
	| "reconciling"
	| "published"
	| "invalid"
	| "rejected"
	| "cancelled"
	| "expired"
	| "failed"
	| "conflict";

export type IntentActorRealm = "oidc" | "publisher" | "approver" | "access" | "system";

const ALLOWED_TRANSITIONS: Readonly<Record<IntentState, ReadonlySet<IntentState>>> = {
	received: new Set(["verifying", "cancelled", "expired"]),
	verifying: new Set(["verified", "invalid", "failed", "cancelled", "expired"]),
	verified: new Set(["ready", "awaiting_approval", "invalid", "failed", "cancelled", "expired"]),
	awaiting_approval: new Set(["ready", "rejected", "invalid", "cancelled", "expired"]),
	ready: new Set(["publishing", "invalid", "cancelled", "expired", "conflict"]),
	publishing: new Set(["ready", "published", "reconciling", "failed", "conflict"]),
	reconciling: new Set(["ready", "published", "failed", "conflict"]),
	published: new Set(),
	invalid: new Set(),
	rejected: new Set(),
	cancelled: new Set(),
	expired: new Set(),
	failed: new Set(),
	conflict: new Set(),
};
const RESERVATION_RELEASING_STATES: ReadonlySet<IntentState> = new Set([
	"invalid",
	"rejected",
	"cancelled",
	"expired",
	"failed",
	"conflict",
]);

export interface StoredIntent {
	id: string;
	packageSlug: string;
	version: string;
	state: IntentState;
	stateGeneration: number;
	workloadPolicyVersion: number;
	workloadIdentityDigest: string;
	workloadIdempotencyDigest: string;
	requestDigest: string;
	workloadIdentityJson: string;
	releaseInputJson: string;
	stateDataJson: string;
	workflowId: string | null;
	expiresAt: number;
	createdAt: number;
	updatedAt: number;
}

export interface CreateIntentInput {
	publisherDid: string;
	intentId: string;
	packageSlug: string;
	version: string;
	workloadPolicyVersion: number;
	workloadIdentityDigest: string;
	workloadIdempotencyDigest: string;
	idempotencyKey: string;
	requestDigest: string;
	workloadIdentityJson: string;
	releaseInputJson: string;
	expiresAt: number;
	now?: number;
}

export type CreateIntentResult =
	| { ok: true; intent: StoredIntent; replayed: boolean }
	| { ok: false; code: "IDEMPOTENCY_CONFLICT" }
	| { ok: false; code: "RESERVATION_CONFLICT"; existingIntentId: string }
	| { ok: false; code: "WORKLOAD_POLICY_UNAVAILABLE" }
	| { ok: false; code: "PUBLISHER_SUSPENDED" };

export interface IntentIdempotencyMatch {
	intent: StoredIntent;
	requestDigest: string;
}

export interface TransitionIntentInput {
	publisherDid: string;
	intentId: string;
	expectedState: IntentState;
	expectedGeneration: number;
	toState: IntentState;
	transitionDigest: string;
	actorRealm: IntentActorRealm;
	actorIdentity: string;
	reasonCode: string | null;
	stateDataJson: string;
	workflowId?: string;
	now?: number;
}

export type TransitionIntentResult =
	| { ok: true; intent: StoredIntent; replayed: boolean }
	| { ok: false; code: "INTENT_NOT_FOUND" }
	| { ok: false; code: "INTENT_CAS_REQUIRED" }
	| { ok: false; code: "INTENT_TRANSITION_INVALID" };

export interface IntentTransition {
	sequence: number;
	fromState: IntentState | null;
	toState: IntentState;
	stateGeneration: number;
	transitionDigest: string;
	actorRealm: IntentActorRealm;
	actorIdentity: string;
	reasonCode: string | null;
	stateDataJson: string;
	createdAt: number;
}

interface IntentRow {
	[key: string]: string | number | ArrayBuffer | null;
	id: string;
	package_slug: string;
	version: string;
	state: IntentState;
	state_generation: number;
	workload_policy_version: number;
	workload_identity_digest: string;
	workload_idempotency_digest: string;
	request_digest: string;
	workload_identity_json: string;
	release_input_json: string;
	state_data_json: string;
	workflow_id: string | null;
	expires_at: number;
	created_at: number;
	updated_at: number;
}

interface IdempotencyRow {
	[key: string]: string | number | ArrayBuffer | null;
	request_digest: string;
	intent_id: string;
	expires_at: number;
}

interface TransitionRow {
	[key: string]: string | number | ArrayBuffer | null;
	sequence: number;
	from_state: IntentState | null;
	to_state: IntentState;
	state_generation: number;
	transition_digest: string;
	actor_realm: IntentActorRealm;
	actor_identity: string;
	reason_code: string | null;
	state_data_json: string;
	created_at: number;
}

export class IntentStateError extends Error {
	readonly code = "INTENT_INPUT_INVALID";

	constructor() {
		super("INTENT_INPUT_INVALID");
		this.name = "IntentStateError";
	}
}

function validCanonicalObjectJson(value: unknown, maximum: number): value is string {
	if (typeof value !== "string" || value.length < 2 || value.length > maximum) return false;
	try {
		const parsed: unknown = JSON.parse(value);
		return (
			parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed) &&
			JSON.stringify(parsed) === value
		);
	} catch {
		return false;
	}
}

function validState(value: unknown): value is IntentState {
	return typeof value === "string" && Object.hasOwn(ALLOWED_TRANSITIONS, value);
}

function validReason(value: unknown): value is string | null {
	return value === null || (typeof value === "string" && REASON_CODE_PATTERN.test(value));
}

function rowToIntent(row: IntentRow): StoredIntent {
	return {
		id: row.id,
		packageSlug: row.package_slug,
		version: row.version,
		state: row.state,
		stateGeneration: row.state_generation,
		workloadPolicyVersion: row.workload_policy_version,
		workloadIdentityDigest: row.workload_identity_digest,
		workloadIdempotencyDigest: row.workload_idempotency_digest,
		requestDigest: row.request_digest,
		workloadIdentityJson: row.workload_identity_json,
		releaseInputJson: row.release_input_json,
		stateDataJson: row.state_data_json,
		workflowId: row.workflow_id,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function initializeIntentStateSchema(storage: DurableObjectStorage): void {
	storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS intents (
			id TEXT PRIMARY KEY,
			package_slug TEXT NOT NULL,
			version TEXT NOT NULL,
			state TEXT NOT NULL,
			state_generation INTEGER NOT NULL CHECK (state_generation >= 1),
			workload_policy_version INTEGER NOT NULL CHECK (workload_policy_version >= 1),
			workload_identity_digest TEXT NOT NULL,
			workload_idempotency_digest TEXT NOT NULL,
			request_digest TEXT NOT NULL,
			workload_identity_json TEXT NOT NULL,
			release_input_json TEXT NOT NULL,
			state_data_json TEXT NOT NULL,
			workflow_id TEXT,
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_intents_state ON intents(state, id);
		CREATE INDEX IF NOT EXISTS idx_intents_expiry ON intents(expires_at, id);
		CREATE TABLE IF NOT EXISTS intent_transitions (
			intent_id TEXT NOT NULL,
			sequence INTEGER NOT NULL,
			from_state TEXT,
			to_state TEXT NOT NULL,
			state_generation INTEGER NOT NULL,
			transition_digest TEXT NOT NULL,
			actor_realm TEXT NOT NULL,
			actor_identity TEXT NOT NULL,
			reason_code TEXT,
			state_data_json TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (intent_id, sequence),
			UNIQUE (intent_id, state_generation)
		);
		CREATE TABLE IF NOT EXISTS release_reservations (
			package_slug TEXT NOT NULL,
			version TEXT NOT NULL,
			intent_id TEXT NOT NULL UNIQUE,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (package_slug, version)
		);
		CREATE TABLE IF NOT EXISTS intent_idempotency (
			workload_idempotency_digest TEXT NOT NULL,
			mutation_key TEXT NOT NULL,
			request_digest TEXT NOT NULL,
			intent_id TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			PRIMARY KEY (workload_idempotency_digest, mutation_key)
		);
		CREATE INDEX IF NOT EXISTS idx_intent_idempotency_expiry
			ON intent_idempotency(expires_at);
	`);
}

export class IntentStateStore {
	readonly #storage: DurableObjectStorage;

	constructor(storage: DurableObjectStorage) {
		this.#storage = storage;
	}

	create(input: CreateIntentInput): CreateIntentResult {
		const now = input.now ?? Date.now();
		if (
			!DID_PATTERN.test(input.publisherDid) ||
			!ULID_PATTERN.test(input.intentId) ||
			!PACKAGE_SLUG_PATTERN.test(input.packageSlug) ||
			!VERSION_PATTERN.test(input.version) ||
			!Number.isSafeInteger(input.workloadPolicyVersion) ||
			input.workloadPolicyVersion < 1 ||
			!DIGEST_PATTERN.test(input.workloadIdentityDigest) ||
			!DIGEST_PATTERN.test(input.workloadIdempotencyDigest) ||
			!IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) ||
			!DIGEST_PATTERN.test(input.requestDigest) ||
			!validCanonicalObjectJson(input.workloadIdentityJson, MAX_WORKLOAD_JSON_CHARS) ||
			!validCanonicalObjectJson(input.releaseInputJson, MAX_RELEASE_INPUT_JSON_CHARS) ||
			!Number.isSafeInteger(now) ||
			now < 0 ||
			!Number.isSafeInteger(input.expiresAt) ||
			input.expiresAt <= now ||
			input.expiresAt - now > MAX_INTENT_LIFETIME_MS
		) {
			throw new IntentStateError();
		}
		return this.#storage.transactionSync(() => {
			const idempotency = this.#storage.sql
				.exec<IdempotencyRow>(
					`SELECT request_digest, intent_id, expires_at FROM intent_idempotency
					 WHERE workload_idempotency_digest = ? AND mutation_key = ?`,
					input.workloadIdempotencyDigest,
					input.idempotencyKey,
				)
				.toArray()[0];
			if (idempotency && idempotency.expires_at > now) {
				if (idempotency.request_digest !== input.requestDigest) {
					return { ok: false, code: "IDEMPOTENCY_CONFLICT" } as const;
				}
				const intent = this.get(idempotency.intent_id);
				if (!intent) throw new IntentStateError();
				return { ok: true, intent, replayed: true } as const;
			}
			if (idempotency) {
				this.#storage.sql.exec(
					`DELETE FROM intent_idempotency
					 WHERE workload_idempotency_digest = ? AND mutation_key = ?`,
					input.workloadIdempotencyDigest,
					input.idempotencyKey,
				);
			}
			const publisher = this.#storage.sql
				.exec<{ status: string }>("SELECT status FROM publisher WHERE id = 1")
				.toArray()[0];
			if (!publisher || publisher.status !== "active") {
				return { ok: false, code: "PUBLISHER_SUSPENDED" } as const;
			}
			const policy = this.#storage.sql
				.exec<{ active: number; state_version: number }>(
					`SELECT active, state_version FROM workload_policies WHERE package_slug = ?`,
					input.packageSlug,
				)
				.toArray()[0];
			if (!policy || policy.active !== 1 || policy.state_version !== input.workloadPolicyVersion) {
				return { ok: false, code: "WORKLOAD_POLICY_UNAVAILABLE" } as const;
			}
			this.#storage.sql.exec(
				`DELETE FROM release_reservations
				 WHERE package_slug = ? AND version = ?
				   AND NOT EXISTS (
				     SELECT 1 FROM intents
				      WHERE intents.id = release_reservations.intent_id
				        AND (
				          intents.state IN ('published', 'publishing', 'reconciling')
				          OR (
				            intents.expires_at > ?
				            AND intents.state NOT IN (
				              'invalid', 'rejected', 'cancelled', 'expired', 'failed', 'conflict'
				            )
				          )
				        )
				   )`,
				input.packageSlug,
				input.version,
				now,
			);
			const reservation = this.#storage.sql
				.exec<{ intent_id: string }>(
					`SELECT intent_id FROM release_reservations
					 WHERE package_slug = ? AND version = ?`,
					input.packageSlug,
					input.version,
				)
				.toArray()[0];
			if (reservation) {
				return {
					ok: false,
					code: "RESERVATION_CONFLICT",
					existingIntentId: reservation.intent_id,
				} as const;
			}
			this.#storage.sql.exec(
				`INSERT INTO intents (
					id, package_slug, version, state, state_generation,
					workload_policy_version, workload_identity_digest, workload_idempotency_digest,
					request_digest, workload_identity_json,
					release_input_json, state_data_json, workflow_id,
					expires_at, created_at, updated_at
				) VALUES (?, ?, ?, 'received', 1, ?, ?, ?, ?, ?, ?, '{}', NULL, ?, ?, ?)`,
				input.intentId,
				input.packageSlug,
				input.version,
				input.workloadPolicyVersion,
				input.workloadIdentityDigest,
				input.workloadIdempotencyDigest,
				input.requestDigest,
				input.workloadIdentityJson,
				input.releaseInputJson,
				input.expiresAt,
				now,
				now,
			);
			this.#storage.sql.exec(
				`INSERT INTO release_reservations (package_slug, version, intent_id, created_at)
				 VALUES (?, ?, ?, ?)`,
				input.packageSlug,
				input.version,
				input.intentId,
				now,
			);
			this.#storage.sql.exec(
				`INSERT INTO intent_idempotency (
					workload_idempotency_digest, mutation_key, request_digest, intent_id, expires_at
				) VALUES (?, ?, ?, ?, ?)`,
				input.workloadIdempotencyDigest,
				input.idempotencyKey,
				input.requestDigest,
				input.intentId,
				input.expiresAt,
			);
			this.#storage.sql.exec(
				`INSERT INTO intent_transitions (
					intent_id, sequence, from_state, to_state, state_generation,
					transition_digest, actor_realm, actor_identity, reason_code,
					state_data_json, created_at
				) VALUES (?, 1, NULL, 'received', 1, ?, 'oidc', ?, NULL, '{}', ?)`,
				input.intentId,
				input.requestDigest,
				input.workloadIdentityDigest,
				now,
			);
			this.#storage.sql.exec(
				`INSERT INTO audit_events (
					event_type, actor_realm, actor_identity, subject,
					reason_code, public_payload, created_at
				) VALUES ('intent-received', 'oidc', ?, ?, NULL, '{}', ?)`,
				input.workloadIdentityDigest,
				input.intentId,
				now,
			);
			return { ok: true, intent: this.get(input.intentId)!, replayed: false } as const;
		});
	}

	findIdempotent(
		workloadIdempotencyDigest: string,
		idempotencyKey: string,
		now = Date.now(),
	): IntentIdempotencyMatch | null {
		if (
			!DIGEST_PATTERN.test(workloadIdempotencyDigest) ||
			!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey) ||
			!Number.isSafeInteger(now) ||
			now < 0
		) {
			throw new IntentStateError();
		}
		return this.#storage.transactionSync(() => {
			const row = this.#storage.sql
				.exec<IdempotencyRow>(
					`SELECT request_digest, intent_id, expires_at FROM intent_idempotency
					 WHERE workload_idempotency_digest = ? AND mutation_key = ?`,
					workloadIdempotencyDigest,
					idempotencyKey,
				)
				.toArray()[0];
			if (!row) return null;
			if (row.expires_at <= now) {
				this.#storage.sql.exec(
					`DELETE FROM intent_idempotency
					 WHERE workload_idempotency_digest = ? AND mutation_key = ?`,
					workloadIdempotencyDigest,
					idempotencyKey,
				);
				return null;
			}
			const intent = this.get(row.intent_id);
			if (!intent) throw new IntentStateError();
			return { intent, requestDigest: row.request_digest };
		});
	}

	transition(input: TransitionIntentInput): TransitionIntentResult {
		const now = input.now ?? Date.now();
		if (
			!DID_PATTERN.test(input.publisherDid) ||
			!ULID_PATTERN.test(input.intentId) ||
			!validState(input.expectedState) ||
			!Number.isSafeInteger(input.expectedGeneration) ||
			input.expectedGeneration < 1 ||
			!validState(input.toState) ||
			!DIGEST_PATTERN.test(input.transitionDigest) ||
			(input.actorRealm !== "oidc" &&
				input.actorRealm !== "publisher" &&
				input.actorRealm !== "approver" &&
				input.actorRealm !== "access" &&
				input.actorRealm !== "system") ||
			!ACTOR_IDENTITY_PATTERN.test(input.actorIdentity) ||
			!validReason(input.reasonCode) ||
			!validCanonicalObjectJson(input.stateDataJson, MAX_STATE_DATA_JSON_CHARS) ||
			(input.workflowId !== undefined && !WORKFLOW_ID_PATTERN.test(input.workflowId)) ||
			!Number.isSafeInteger(now) ||
			now < 0
		) {
			throw new IntentStateError();
		}
		return this.#storage.transactionSync(() => {
			const current = this.get(input.intentId);
			if (!current) return { ok: false, code: "INTENT_NOT_FOUND" } as const;
			const activePublication = current.state === "publishing" || current.state === "reconciling";
			if (current.expiresAt <= now && !activePublication && input.toState !== "expired") {
				return { ok: false, code: "INTENT_TRANSITION_INVALID" } as const;
			}
			if (
				current.state !== input.expectedState ||
				current.stateGeneration !== input.expectedGeneration
			) {
				const replay =
					current.stateGeneration === input.expectedGeneration + 1
						? this.#storage.sql
								.exec<{ transition_digest: string; to_state: IntentState }>(
									`SELECT transition_digest, to_state FROM intent_transitions
						 WHERE intent_id = ? AND state_generation = ?`,
									input.intentId,
									input.expectedGeneration + 1,
								)
								.toArray()[0]
						: undefined;
				if (
					replay?.transition_digest === input.transitionDigest &&
					replay.to_state === input.toState
				) {
					return { ok: true, intent: current, replayed: true } as const;
				}
				return { ok: false, code: "INTENT_CAS_REQUIRED" } as const;
			}
			if (!ALLOWED_TRANSITIONS[current.state].has(input.toState)) {
				return { ok: false, code: "INTENT_TRANSITION_INVALID" } as const;
			}
			if (
				(input.workflowId !== undefined &&
					current.workflowId !== null &&
					input.workflowId !== current.workflowId) ||
				(input.workflowId !== undefined &&
					current.workflowId === null &&
					(current.state !== "received" || input.toState !== "verifying"))
			) {
				return { ok: false, code: "INTENT_TRANSITION_INVALID" } as const;
			}
			const nextGeneration = current.stateGeneration + 1;
			const workflowId = input.workflowId ?? current.workflowId;
			this.#storage.sql.exec(
				`UPDATE intents SET
					state = ?, state_generation = ?, state_data_json = ?,
					workflow_id = ?, updated_at = ?
				 WHERE id = ?`,
				input.toState,
				nextGeneration,
				input.stateDataJson,
				workflowId,
				now,
				input.intentId,
			);
			this.#storage.sql.exec(
				`INSERT INTO intent_transitions (
					intent_id, sequence, from_state, to_state, state_generation,
					transition_digest, actor_realm, actor_identity, reason_code,
					state_data_json, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				input.intentId,
				nextGeneration,
				current.state,
				input.toState,
				nextGeneration,
				input.transitionDigest,
				input.actorRealm,
				input.actorIdentity,
				input.reasonCode,
				input.stateDataJson,
				now,
			);
			this.#storage.sql.exec(
				`INSERT INTO audit_events (
					event_type, actor_realm, actor_identity, subject,
					reason_code, public_payload, created_at
				) VALUES ('intent-transitioned', ?, ?, ?, ?, '{}', ?)`,
				input.actorRealm,
				input.actorIdentity,
				input.intentId,
				input.reasonCode,
				now,
			);
			if (RESERVATION_RELEASING_STATES.has(input.toState)) {
				this.#storage.sql.exec(
					"DELETE FROM release_reservations WHERE intent_id = ?",
					input.intentId,
				);
			}
			return { ok: true, intent: this.get(input.intentId)!, replayed: false } as const;
		});
	}

	get(intentId: string): StoredIntent | null {
		if (!ULID_PATTERN.test(intentId)) throw new IntentStateError();
		const row = this.#storage.sql
			.exec<IntentRow>(
				`SELECT id, package_slug, version, state, state_generation,
				        workload_policy_version, workload_identity_digest, workload_idempotency_digest,
				        request_digest, workload_identity_json,
				        release_input_json, state_data_json, workflow_id,
				        expires_at, created_at, updated_at
				 FROM intents WHERE id = ?`,
				intentId,
			)
			.toArray()[0];
		return row ? rowToIntent(row) : null;
	}

	list(afterIntentId: string | null, limit: number): readonly StoredIntent[] {
		if (
			(afterIntentId !== null && !ULID_PATTERN.test(afterIntentId)) ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > MAX_LIST_LIMIT
		) {
			throw new IntentStateError();
		}
		return this.#storage.sql
			.exec<IntentRow>(
				`SELECT id, package_slug, version, state, state_generation,
				        workload_policy_version, workload_identity_digest, workload_idempotency_digest,
				        request_digest, workload_identity_json, release_input_json, state_data_json,
				        workflow_id, expires_at, created_at, updated_at
				 FROM intents WHERE (? IS NULL OR id < ?)
				 ORDER BY id DESC LIMIT ?`,
				afterIntentId,
				afterIntentId,
				limit,
			)
			.toArray()
			.map(rowToIntent);
	}

	listExpirable(now: number, limit: number): readonly StoredIntent[] {
		if (
			!Number.isSafeInteger(now) ||
			now < 0 ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 100
		) {
			throw new IntentStateError();
		}
		return this.#storage.sql
			.exec<IntentRow>(
				`SELECT id, package_slug, version, state, state_generation,
				        workload_policy_version, workload_identity_digest, workload_idempotency_digest,
				        request_digest, workload_identity_json, release_input_json, state_data_json,
				        workflow_id, expires_at, created_at, updated_at
				 FROM intents
				 WHERE expires_at <= ?
				   AND state IN ('received', 'verifying', 'verified', 'awaiting_approval', 'ready')
				 ORDER BY expires_at, id LIMIT ?`,
				now,
				limit,
			)
			.toArray()
			.map(rowToIntent);
	}

	listTransitions(intentId: string): readonly IntentTransition[] {
		if (!ULID_PATTERN.test(intentId)) throw new IntentStateError();
		return this.#storage.sql
			.exec<TransitionRow>(
				`SELECT sequence, from_state, to_state, state_generation,
				        transition_digest, actor_realm, actor_identity,
				        reason_code, state_data_json, created_at
				 FROM intent_transitions WHERE intent_id = ? ORDER BY sequence`,
				intentId,
			)
			.toArray()
			.map((row) => ({
				sequence: row.sequence,
				fromState: row.from_state,
				toState: row.to_state,
				stateGeneration: row.state_generation,
				transitionDigest: row.transition_digest,
				actorRealm: row.actor_realm,
				actorIdentity: row.actor_identity,
				reasonCode: row.reason_code,
				stateDataJson: row.state_data_json,
				createdAt: row.created_at,
			}));
	}
}
