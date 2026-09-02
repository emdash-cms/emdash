import { base64url } from "jose";

import { evaluateWorkloadPolicy } from "../workload/policy.js";
import type { VerifiedWorkloadIdentity } from "../workload/types.js";
import { WorkloadPolicyStore } from "./workload-policy.js";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const AT_URI_PATTERN =
	/^at:\/\/did:[a-z0-9]+:[A-Za-z0-9._:%-]+\/[a-zA-Z0-9.-]+\/[A-Za-z0-9._:~-]+$/;
const CID_PATTERN = /^[A-Za-z0-9]+$/;
const MAX_LEASE_MS = 5 * 60_000;

export interface PublicationOperationLease {
	intentId: string;
	generation: number;
	token: string;
	expectedIntentGeneration: number;
	expiresAt: number;
}

export type PublicationOperationPhase = "creating" | "materialized" | "uploading";

export interface AdvancePublicationOperationPhaseInput {
	publisherDid: string;
	intentId: string;
	generation: number;
	token: string;
	expectedIntentGeneration: number;
	phase: "creating" | "materialized";
	materializationDigest: string;
	now?: number;
}

export type AdvancePublicationOperationPhaseResult =
	| {
			ok: true;
			phase: "creating" | "materialized";
			materializationDigest: string;
			replayed: boolean;
	  }
	| {
			ok: false;
			code:
				| "MATERIALIZATION_UNAVAILABLE"
				| "PUBLICATION_CAS_REQUIRED"
				| "PUBLICATION_PHASE_CONFLICT"
				| "WORKLOAD_POLICY_UNAVAILABLE";
	  };

export interface PublicationWorkloadAuthorization {
	identity: VerifiedWorkloadIdentity;
	identityDigest: string;
	identityJson: string;
}

export type BeginPublicationOperationResult =
	| { ok: true; lease: PublicationOperationLease; replayed: boolean }
	| {
			ok: false;
			code: "INTENT_UNAVAILABLE" | "INTENT_CAS_REQUIRED" | "PUBLICATION_RECOVERY_REQUIRED";
	  }
	| { ok: false; code: "PUBLICATION_BUSY"; retryAt: number };

export type PublicationOutcome = "published" | "ambiguous" | "blocked" | "conflict" | "failed";

export interface CompletePublicationOperationInput {
	publisherDid: string;
	intentId: string;
	generation: number;
	token: string;
	expectedIntentGeneration: number;
	completionDigest: string;
	outcome: PublicationOutcome;
	reasonCode?: string | null;
	resultUri: string | null;
	resultCid: string | null;
	now?: number;
}

export type CompletePublicationOperationResult =
	| {
			ok: true;
			state: "published" | "reconciling" | "ready" | "conflict" | "failed";
			stateGeneration: number;
			replayed: boolean;
	  }
	| { ok: false; code: "PUBLICATION_CAS_REQUIRED" };

interface OperationRow {
	[key: string]: string | number | ArrayBuffer | null;
	generation: number;
	attempt_key: string;
	token_hash: string | null;
	intent_generation: number;
	status: "active" | "completed";
	phase: PublicationOperationPhase;
	materialization_digest: string | null;
	expires_at: number;
	completion_digest: string | null;
	outcome: PublicationOutcome | null;
	reason_code: string | null;
	result_uri: string | null;
	result_cid: string | null;
	completed_at: number | null;
}

interface IntentRow {
	[key: string]: string | number | ArrayBuffer | null;
	state: string;
	state_generation: number;
	package_slug: string;
	workload_policy_version: number;
	workload_identity_digest: string;
	workload_identity_json: string;
}

export class PublicationOperationError extends Error {
	readonly code = "PUBLICATION_OPERATION_INVALID";

	constructor() {
		super("PUBLICATION_OPERATION_INVALID");
		this.name = "PublicationOperationError";
	}
}

async function hashToken(token: string): Promise<string> {
	return base64url.encode(
		new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
	);
}

function hashesEqual(left: string, right: string): boolean {
	try {
		const leftBytes = base64url.decode(left);
		const rightBytes = base64url.decode(right);
		return (
			leftBytes.length === rightBytes.length && crypto.subtle.timingSafeEqual(leftBytes, rightBytes)
		);
	} catch {
		return false;
	}
}

function readIntent(storage: DurableObjectStorage, intentId: string): IntentRow | null {
	return (
		storage.sql
			.exec<IntentRow>(
				`SELECT state, state_generation, package_slug, workload_policy_version,
				        workload_identity_digest, workload_identity_json
				 FROM intents WHERE id = ?`,
				intentId,
			)
			.toArray()[0] ?? null
	);
}

function stateForOutcome(outcome: PublicationOutcome) {
	if (outcome === "published") return "published" as const;
	if (outcome === "ambiguous") return "reconciling" as const;
	if (outcome === "blocked") return "ready" as const;
	if (outcome === "conflict") return "conflict" as const;
	return "failed" as const;
}

function reasonForOutcome(input: CompletePublicationOperationInput): string | null {
	if (input.outcome === "ambiguous") return "PDS_AMBIGUOUS";
	if (input.outcome === "conflict") return "RELEASE_CONFLICT";
	if (input.outcome === "blocked" || input.outcome === "failed") return input.reasonCode!;
	return null;
}

function requiresCreatingPhase(outcome: PublicationOutcome): boolean {
	return outcome === "published" || outcome === "ambiguous" || outcome === "conflict";
}

function phaseAllowsOutcome(operation: OperationRow, outcome: PublicationOutcome): boolean {
	return operation.phase === "creating"
		? requiresCreatingPhase(outcome) && operation.materialization_digest !== null
		: !requiresCreatingPhase(outcome);
}

export function initializePublicationOperationSchema(storage: DurableObjectStorage): void {
	storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS publication_operations (
			intent_id TEXT PRIMARY KEY,
			generation INTEGER NOT NULL CHECK (generation >= 1),
			attempt_key TEXT NOT NULL,
			token_hash TEXT,
			intent_generation INTEGER NOT NULL CHECK (intent_generation >= 1),
			status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
			phase TEXT NOT NULL CHECK (phase IN ('uploading', 'materialized', 'creating')),
			materialization_digest TEXT,
			expires_at INTEGER NOT NULL,
			completion_digest TEXT,
			outcome TEXT CHECK (outcome IN ('published', 'ambiguous', 'blocked', 'conflict', 'failed')),
			reason_code TEXT,
			result_uri TEXT,
			result_cid TEXT,
			started_at INTEGER NOT NULL,
			completed_at INTEGER
		);
		CREATE INDEX IF NOT EXISTS idx_publication_operations_expiry
			ON publication_operations(status, expires_at);
		CREATE TABLE IF NOT EXISTS deadlines (
			kind TEXT NOT NULL CHECK (kind IN ('publication-operation')),
			subject_id TEXT NOT NULL,
			generation INTEGER NOT NULL CHECK (generation >= 1),
			scheduled_at INTEGER NOT NULL,
			PRIMARY KEY (kind, subject_id)
		);
		CREATE INDEX IF NOT EXISTS idx_deadlines_schedule
			ON deadlines(scheduled_at, kind, subject_id);
	`);
}

export class PublicationOperationStore {
	readonly #storage: DurableObjectStorage;

	constructor(storage: DurableObjectStorage) {
		this.#storage = storage;
	}

	async begin(
		publisherDid: string,
		intentId: string,
		expectedIntentGeneration: number,
		leaseMs: number,
		attemptKey: string,
		token: string,
		now = Date.now(),
	): Promise<BeginPublicationOperationResult> {
		const operationNow = now;
		if (
			!DID_PATTERN.test(publisherDid) ||
			!ULID_PATTERN.test(intentId) ||
			!Number.isSafeInteger(expectedIntentGeneration) ||
			expectedIntentGeneration < 1 ||
			!Number.isSafeInteger(leaseMs) ||
			leaseMs < 1 ||
			leaseMs > MAX_LEASE_MS ||
			!DIGEST_PATTERN.test(attemptKey) ||
			!TOKEN_PATTERN.test(token) ||
			!Number.isSafeInteger(operationNow) ||
			operationNow < 0 ||
			operationNow > Number.MAX_SAFE_INTEGER - leaseMs
		) {
			throw new PublicationOperationError();
		}
		const tokenHash = await hashToken(token);
		return this.#storage.transactionSync(() => {
			const intent = readIntent(this.#storage, intentId);
			if (!intent || intent.state !== "publishing") {
				return { ok: false, code: "INTENT_UNAVAILABLE" } as const;
			}
			if (intent.state_generation !== expectedIntentGeneration) {
				return { ok: false, code: "INTENT_CAS_REQUIRED" } as const;
			}
			const current = this.#storage.sql
				.exec<OperationRow>(
					`SELECT generation, attempt_key, token_hash, intent_generation, status, phase,
					        materialization_digest, expires_at, completion_digest, outcome,
					        reason_code, result_uri, result_cid, completed_at
					 FROM publication_operations WHERE intent_id = ?`,
					intentId,
				)
				.toArray()[0];
			if (
				current?.status === "active" &&
				current.expires_at > operationNow &&
				current.attempt_key === attemptKey &&
				current.token_hash !== null &&
				current.intent_generation === expectedIntentGeneration &&
				hashesEqual(current.token_hash, tokenHash)
			) {
				return {
					ok: true,
					lease: {
						intentId,
						generation: current.generation,
						token,
						expectedIntentGeneration,
						expiresAt: current.expires_at,
					},
					replayed: true,
				} as const;
			}
			if (current?.status === "active" && current.expires_at > operationNow) {
				return { ok: false, code: "PUBLICATION_BUSY", retryAt: current.expires_at } as const;
			}
			if (current?.status === "active") {
				return { ok: false, code: "PUBLICATION_RECOVERY_REQUIRED" } as const;
			}
			const generation = (current?.generation ?? 0) + 1;
			const expiresAt = operationNow + leaseMs;
			this.#storage.sql.exec(
				`INSERT INTO publication_operations (
					intent_id, generation, attempt_key, token_hash, intent_generation, status, phase,
					materialization_digest,
					expires_at, completion_digest, outcome, reason_code, result_uri, result_cid,
					started_at, completed_at
				) VALUES (?, ?, ?, ?, ?, 'active', 'uploading', NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL)
				ON CONFLICT(intent_id) DO UPDATE SET
					generation = excluded.generation,
					attempt_key = excluded.attempt_key,
					token_hash = excluded.token_hash,
					intent_generation = excluded.intent_generation,
					status = 'active',
					phase = 'uploading',
					materialization_digest = NULL,
					expires_at = excluded.expires_at,
					completion_digest = NULL,
					outcome = NULL,
					reason_code = NULL,
					result_uri = NULL,
					result_cid = NULL,
					started_at = excluded.started_at,
					completed_at = NULL`,
				intentId,
				generation,
				attemptKey,
				tokenHash,
				expectedIntentGeneration,
				expiresAt,
				operationNow,
			);
			this.#storage.sql.exec(
				`INSERT INTO deadlines (kind, subject_id, generation, scheduled_at)
				 VALUES ('publication-operation', ?, ?, ?)
				 ON CONFLICT(kind, subject_id) DO UPDATE SET
					generation = excluded.generation, scheduled_at = excluded.scheduled_at`,
				intentId,
				generation,
				expiresAt,
			);
			this.#storage.sql.exec(
				`INSERT INTO audit_events (
					event_type, actor_realm, actor_identity, subject,
					reason_code, public_payload, created_at
				) VALUES ('publication-operation-started', 'system',
				          'release-service', ?, NULL, '{}', ?)`,
				intentId,
				operationNow,
			);
			return {
				ok: true,
				lease: { intentId, generation, token, expectedIntentGeneration, expiresAt },
				replayed: false,
			} as const;
		});
	}

	async advancePhase(
		input: AdvancePublicationOperationPhaseInput,
		authorization: PublicationWorkloadAuthorization | null = null,
	): Promise<AdvancePublicationOperationPhaseResult> {
		const now = input.now ?? Date.now();
		if (
			!DID_PATTERN.test(input.publisherDid) ||
			!ULID_PATTERN.test(input.intentId) ||
			!Number.isSafeInteger(input.generation) ||
			input.generation < 1 ||
			!TOKEN_PATTERN.test(input.token) ||
			!Number.isSafeInteger(input.expectedIntentGeneration) ||
			input.expectedIntentGeneration < 1 ||
			(input.phase !== "materialized" && input.phase !== "creating") ||
			!DIGEST_PATTERN.test(input.materializationDigest) ||
			!Number.isSafeInteger(now) ||
			now < 0
		) {
			throw new PublicationOperationError();
		}
		const tokenHash = await hashToken(input.token);
		return this.#storage.transactionSync(() => {
			const operation = this.#storage.sql
				.exec<OperationRow>(
					`SELECT generation, attempt_key, token_hash, intent_generation, status, phase,
					        materialization_digest, expires_at, completion_digest, outcome, completed_at
					 FROM publication_operations WHERE intent_id = ?`,
					input.intentId,
				)
				.toArray()[0];
			const intent = readIntent(this.#storage, input.intentId);
			if (
				!operation ||
				operation.status !== "active" ||
				operation.generation !== input.generation ||
				operation.token_hash === null ||
				!hashesEqual(operation.token_hash, tokenHash) ||
				operation.intent_generation !== input.expectedIntentGeneration ||
				operation.expires_at <= now ||
				!intent ||
				intent.state !== "publishing" ||
				intent.state_generation !== input.expectedIntentGeneration
			) {
				return { ok: false, code: "PUBLICATION_CAS_REQUIRED" } as const;
			}
			if (operation.phase === input.phase) {
				return operation.materialization_digest === input.materializationDigest
					? ({
							ok: true,
							phase: input.phase,
							materializationDigest: input.materializationDigest,
							replayed: true,
						} as const)
					: ({ ok: false, code: "PUBLICATION_PHASE_CONFLICT" } as const);
			}
			if (operation.phase === "uploading") {
				if (input.phase !== "materialized" || operation.materialization_digest !== null) {
					return { ok: false, code: "PUBLICATION_PHASE_CONFLICT" } as const;
				}
			} else if (
				operation.phase !== "materialized" ||
				input.phase !== "creating" ||
				operation.materialization_digest !== input.materializationDigest
			) {
				return { ok: false, code: "PUBLICATION_PHASE_CONFLICT" } as const;
			}
			const materialization = this.#storage.sql
				.exec<{ record_digest: string | null; status: string }>(
					`SELECT status, record_digest FROM publication_materializations
					 WHERE intent_id = ?`,
					input.intentId,
				)
				.toArray()[0];
			if (
				!materialization ||
				materialization.status !== "complete" ||
				materialization.record_digest !== input.materializationDigest
			) {
				return { ok: false, code: "MATERIALIZATION_UNAVAILABLE" } as const;
			}
			if (input.phase === "creating") {
				const policy = new WorkloadPolicyStore(this.#storage).get(intent.package_slug);
				if (
					!authorization ||
					authorization.identityJson !== intent.workload_identity_json ||
					authorization.identityDigest !== intent.workload_identity_digest ||
					!policy ||
					policy.stateVersion !== intent.workload_policy_version ||
					!evaluateWorkloadPolicy(authorization.identity, policy).ok
				) {
					return { ok: false, code: "WORKLOAD_POLICY_UNAVAILABLE" } as const;
				}
			}
			this.#storage.sql.exec(
				`UPDATE publication_operations SET phase = ?, materialization_digest = ?
				 WHERE intent_id = ? AND generation = ? AND status = 'active'`,
				input.phase,
				input.materializationDigest,
				input.intentId,
				input.generation,
			);
			return {
				ok: true,
				phase: input.phase,
				materializationDigest: input.materializationDigest,
				replayed: false,
			} as const;
		});
	}

	async complete(
		input: CompletePublicationOperationInput,
	): Promise<CompletePublicationOperationResult> {
		const now = input.now ?? Date.now();
		if (
			!DID_PATTERN.test(input.publisherDid) ||
			!ULID_PATTERN.test(input.intentId) ||
			!Number.isSafeInteger(input.generation) ||
			input.generation < 1 ||
			!TOKEN_PATTERN.test(input.token) ||
			!Number.isSafeInteger(input.expectedIntentGeneration) ||
			input.expectedIntentGeneration < 1 ||
			!DIGEST_PATTERN.test(input.completionDigest) ||
			(input.outcome !== "published" &&
				input.outcome !== "ambiguous" &&
				input.outcome !== "blocked" &&
				input.outcome !== "conflict" &&
				input.outcome !== "failed") ||
			((input.outcome === "blocked" || input.outcome === "failed") &&
				(typeof input.reasonCode !== "string" || !REASON_CODE_PATTERN.test(input.reasonCode))) ||
			(input.outcome !== "blocked" && input.outcome !== "failed" && input.reasonCode != null) ||
			(input.outcome === "published" &&
				(typeof input.resultUri !== "string" ||
					!AT_URI_PATTERN.test(input.resultUri) ||
					typeof input.resultCid !== "string" ||
					!CID_PATTERN.test(input.resultCid))) ||
			(input.outcome !== "published" && (input.resultUri !== null || input.resultCid !== null)) ||
			!Number.isSafeInteger(now) ||
			now < 0
		) {
			throw new PublicationOperationError();
		}
		const tokenHash = await hashToken(input.token);
		return this.#storage.transactionSync(() => {
			const operation = this.#storage.sql
				.exec<OperationRow>(
					`SELECT generation, attempt_key, token_hash, intent_generation, status, phase,
					        materialization_digest, expires_at, completion_digest, outcome,
					        reason_code, result_uri, result_cid, completed_at
					 FROM publication_operations WHERE intent_id = ?`,
					input.intentId,
				)
				.toArray()[0];
			const intent = readIntent(this.#storage, input.intentId);
			const replayState = stateForOutcome(input.outcome);
			const reasonCode = reasonForOutcome(input);
			if (
				operation?.status === "completed" &&
				phaseAllowsOutcome(operation, input.outcome) &&
				operation.generation === input.generation &&
				operation.token_hash !== null &&
				hashesEqual(operation.token_hash, tokenHash) &&
				operation.completion_digest === input.completionDigest &&
				operation.outcome === input.outcome &&
				operation.reason_code === reasonCode &&
				operation.result_uri === input.resultUri &&
				operation.result_cid === input.resultCid &&
				intent?.state === replayState &&
				intent.state_generation === input.expectedIntentGeneration + 1
			) {
				return {
					ok: true,
					state: replayState,
					stateGeneration: intent.state_generation,
					replayed: true,
				} as const;
			}
			if (
				!operation ||
				operation.status !== "active" ||
				!phaseAllowsOutcome(operation, input.outcome) ||
				operation.generation !== input.generation ||
				operation.token_hash === null ||
				!hashesEqual(operation.token_hash, tokenHash) ||
				operation.intent_generation !== input.expectedIntentGeneration ||
				(operation.expires_at <= now &&
					(input.outcome === "published" || input.outcome === "conflict")) ||
				!intent ||
				intent.state !== "publishing" ||
				intent.state_generation !== input.expectedIntentGeneration
			) {
				return { ok: false, code: "PUBLICATION_CAS_REQUIRED" } as const;
			}
			const nextState = stateForOutcome(input.outcome);
			const nextGeneration = intent.state_generation + 1;
			const stateData = JSON.stringify({ resultUri: input.resultUri, resultCid: input.resultCid });
			this.#storage.sql.exec(
				`UPDATE intents SET state = ?, state_generation = ?, state_data_json = ?, updated_at = ?
				 WHERE id = ?`,
				nextState,
				nextGeneration,
				stateData,
				now,
				input.intentId,
			);
			this.#storage.sql.exec(
				`INSERT INTO audit_events (
					event_type, actor_realm, actor_identity, subject,
					reason_code, public_payload, created_at
				) VALUES ('publication-operation-completed', 'system',
				          'release-service', ?, ?, '{}', ?)`,
				input.intentId,
				reasonCode,
				now,
			);
			this.#storage.sql.exec(
				`INSERT INTO intent_transitions (
					intent_id, sequence, from_state, to_state, state_generation,
					transition_digest, actor_realm, actor_identity, reason_code,
					state_data_json, created_at
				) VALUES (?, ?, 'publishing', ?, ?, ?, 'system', 'release-service', ?, ?, ?)`,
				input.intentId,
				nextGeneration,
				nextState,
				nextGeneration,
				input.completionDigest,
				reasonCode,
				stateData,
				now,
			);
			this.#storage.sql.exec(
				`UPDATE publication_operations SET
					status = 'completed', completion_digest = ?, outcome = ?, reason_code = ?,
					result_uri = ?, result_cid = ?, completed_at = ?
				 WHERE intent_id = ?`,
				input.completionDigest,
				input.outcome,
				reasonCode,
				input.resultUri,
				input.resultCid,
				now,
				input.intentId,
			);
			this.#storage.sql.exec(
				"DELETE FROM deadlines WHERE kind = 'publication-operation' AND subject_id = ?",
				input.intentId,
			);
			return {
				ok: true,
				state: nextState,
				stateGeneration: nextGeneration,
				replayed: false,
			} as const;
		});
	}

	recoverExpired(now = Date.now()): number {
		if (!Number.isSafeInteger(now) || now < 0) throw new PublicationOperationError();
		return this.#storage.transactionSync(() => {
			const expired = this.#storage.sql
				.exec<{
					intent_id: string;
					generation: number;
					token_hash: string;
					phase: PublicationOperationPhase;
				}>(
					`SELECT intent_id, generation, token_hash, phase FROM publication_operations
					 WHERE status = 'active' AND expires_at <= ? AND token_hash IS NOT NULL`,
					now,
				)
				.toArray();
			let recovered = 0;
			for (const operation of expired) {
				const intent = readIntent(this.#storage, operation.intent_id);
				if (intent?.state === "publishing") {
					const createStarted = operation.phase === "creating";
					const nextState = createStarted ? "reconciling" : "ready";
					const reasonCode = createStarted ? "PDS_AMBIGUOUS" : "PUBLICATION_RETRY_REQUIRED";
					const eventType = createStarted
						? "publication-operation-recovery-required"
						: "publication-operation-retry-required";
					const stateData = createStarted
						? '{"recovery":"operation-expired-after-create"}'
						: '{"recovery":"operation-expired-before-create"}';
					const nextGeneration = intent.state_generation + 1;
					this.#storage.sql.exec(
						`UPDATE intents SET state = ?, state_generation = ?,
							state_data_json = ?, updated_at = ? WHERE id = ?`,
						nextState,
						nextGeneration,
						stateData,
						now,
						operation.intent_id,
					);
					this.#storage.sql.exec(
						`INSERT INTO intent_transitions (
							intent_id, sequence, from_state, to_state, state_generation,
							transition_digest, actor_realm, actor_identity, reason_code,
							state_data_json, created_at
						) VALUES (?, ?, 'publishing', ?, ?, ?, 'system',
						          'release-service', ?, ?, ?)`,
						operation.intent_id,
						nextGeneration,
						nextState,
						nextGeneration,
						operation.token_hash,
						reasonCode,
						stateData,
						now,
					);
					this.#storage.sql.exec(
						`INSERT INTO audit_events (
							event_type, actor_realm, actor_identity, subject,
							reason_code, public_payload, created_at
						) VALUES (?, 'system', 'release-service', ?, ?, '{}', ?)`,
						eventType,
						operation.intent_id,
						reasonCode,
						now,
					);
					recovered += 1;
				}
				this.#storage.sql.exec(
					`UPDATE publication_operations SET status = 'completed',
						completion_digest = token_hash,
						outcome = CASE WHEN phase = 'creating' THEN 'ambiguous' ELSE NULL END,
						reason_code = CASE WHEN phase = 'creating'
							THEN 'PDS_AMBIGUOUS' ELSE 'PUBLICATION_RETRY_REQUIRED' END,
						result_uri = NULL, result_cid = NULL,
						completed_at = ?
					 WHERE intent_id = ? AND generation = ?`,
					now,
					operation.intent_id,
					operation.generation,
				);
				this.#storage.sql.exec(
					`DELETE FROM deadlines
					 WHERE kind = 'publication-operation' AND subject_id = ? AND generation = ?`,
					operation.intent_id,
					operation.generation,
				);
			}
			return recovered;
		});
	}

	nextDeadline(): number | null {
		return this.#storage.sql
			.exec<{ scheduled_at: number | null }>(
				"SELECT MIN(scheduled_at) AS scheduled_at FROM deadlines",
			)
			.one().scheduled_at;
	}
}
