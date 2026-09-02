import type { AuthenticatorTransport } from "@emdash-cms/auth";

import type {
	EncryptionRecordPage,
	EncryptionRecordReplacement,
} from "../operations/encryption-records.js";
import { MAX_ENCRYPTION_RECORD_PAGE } from "../operations/encryption-records.js";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ALGORITHMS = new Set([-7, -257]);
const MAX_ACTIVE_CREDENTIALS = 10;
const MAX_ACTIVE_IDENTITY_TRANSACTIONS = 20;
const MAX_ACTIVE_SESSIONS = 20;
const MAX_ACTIVE_CHALLENGES = 50;
const MAX_PUBLIC_KEY_BYTES = 16 * 1024;
const MAX_CIPHERTEXT_CHARS = 256 * 1024;
const MAX_CONTEXT_CHARS = 16 * 1024;
const MAX_IDENTITY_TRANSACTION_MS = 10 * 60_000;
const MAX_SESSION_MS = 24 * 60 * 60_000;
const MAX_CHALLENGE_MS = 5 * 60_000;
const MAX_CHALLENGE_CLOCK_SKEW_MS = 5_000;
const COMPLETED_IDENTITY_RETENTION_MS = 60 * 60_000;
const ACTOR_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const ENCRYPTION_CURSOR_PATTERN = /^identity-transaction:[A-Za-z0-9_-]{43}$/;

export type ApproverStoreErrorCode =
	| "APPROVER_DID_INVALID"
	| "APPROVER_DID_MISMATCH"
	| "APPROVER_INPUT_INVALID";

export class ApproverStoreError extends Error {
	constructor(readonly code: ApproverStoreErrorCode) {
		super(code);
		this.name = "ApproverStoreError";
	}
}

export interface PutIdentityTransactionInput {
	approverDid: string;
	stateHash: string;
	encryptedState: string;
	encryptionKeyVersion: number;
	clientKeyId: string;
	redirectTarget: string;
	expiresAt: number;
	now?: number;
}

export interface StoredIdentityTransaction {
	encryptedState: string;
	encryptionKeyVersion: number;
	clientKeyId: string;
	redirectTarget: string;
	expiresAt: number;
}

export type PutIdentityTransactionResult =
	| { ok: true }
	| { ok: false; code: "IDENTITY_TRANSACTION_EXISTS" | "IDENTITY_TRANSACTION_LIMIT_REACHED" };

export interface CreateApproverSessionInput {
	approverDid: string;
	tokenHash: string;
	csrfHash: string;
	expiresAt: number;
	now?: number;
}

export interface StoredApproverSession {
	approverDid: string;
	expiresAt: number;
	sessionEpoch: number;
}

export type CreateApproverSessionResult =
	| { ok: true; session: StoredApproverSession }
	| {
			ok: false;
			code: "APPROVER_SESSION_EXISTS" | "APPROVER_SESSION_LIMIT_REACHED" | "APPROVER_SUSPENDED";
	  };

export type ValidateApproverSessionResult =
	| { ok: true; session: StoredApproverSession }
	| {
			ok: false;
			code: "APPROVER_SESSION_INVALID" | "APPROVER_SESSION_EXPIRED" | "APPROVER_SUSPENDED";
	  };

export interface EnrolCredentialInput {
	credentialId: string;
	publicKey: Uint8Array;
	algorithm: number;
	counter: number;
	transports: AuthenticatorTransport[];
	name: string;
	now?: number;
}

export interface ApproverCredential {
	id: string;
	name: string;
	transports: AuthenticatorTransport[];
	createdAt: number;
	lastUsedAt: number | null;
	revokedAt: number | null;
}

export interface ApproverEnrollmentStatus {
	credentialCount: number;
	activeCredentialCount: number;
	firstEnrolledAt: number | null;
	lastEnrolledAt: number | null;
	lastRevokedAt: number | null;
}

export interface CredentialVerificationMaterial {
	id: string;
	publicKey: Uint8Array;
	algorithm: number;
	counter: number;
	transports: AuthenticatorTransport[];
}

export type EnrolCredentialResult =
	| { ok: true; credential: ApproverCredential }
	| { ok: false; code: "CREDENTIAL_EXISTS" | "CREDENTIAL_LIMIT_REACHED" };

export type RevokeCredentialResult =
	| { ok: true; credential: ApproverCredential }
	| { ok: false; code: "CREDENTIAL_NOT_FOUND" | "CREDENTIAL_REVOKED" };

export type CommitCredentialUseResult =
	| { ok: true; counter: number }
	| {
			ok: false;
			code:
				| "CREDENTIAL_NOT_FOUND"
				| "CREDENTIAL_REVOKED"
				| "CREDENTIAL_STATE_CHANGED"
				| "COUNTER_REGRESSION";
	  };

export interface CreateChallengeInput {
	challengeHash: string;
	kind: "registration" | "approval";
	intentId?: string;
	publisherDid?: string;
	approvalDigest?: string;
	context: string;
	expiresAt: number;
	now?: number;
}

export interface ConsumedChallenge {
	kind: "registration" | "approval";
	intentId: string | null;
	publisherDid: string | null;
	approvalDigest: string | null;
	context: string;
	expiresAt: number;
}

export type CreateChallengeResult =
	| { ok: true }
	| { ok: false; code: "CHALLENGE_EXISTS" | "CHALLENGE_LIMIT_REACHED" };

export type ConsumeChallengeResult =
	| { ok: true; challenge: ConsumedChallenge }
	| {
			ok: false;
			code: "CHALLENGE_NOT_FOUND" | "CHALLENGE_CONSUMED" | "CHALLENGE_EXPIRED";
	  };

export type ApprovalDecision = "approve" | "reject";

export interface ApprovalReceipt {
	approverDid: string;
	publisherDid: string;
	intentId: string;
	approvalDigest: string;
	decision: ApprovalDecision;
	credentialId: string;
	verifiedAt: number;
}

export interface DecisionIdentity {
	idempotencyKey: string;
	intentId: string;
	publisherDid: string;
	approvalDigest: string;
	decision: ApprovalDecision;
	credentialId: string;
}

export interface RecordDecisionInput extends DecisionIdentity {
	verifiedAt: number;
}

export interface CommitVerifiedDecisionInput extends RecordDecisionInput {
	expectedCounter: number;
	newCounter: number;
}

export type RecordDecisionResult =
	| { ok: true; receipt: ApprovalReceipt; replayed: boolean }
	| {
			ok: false;
			code:
				| "CREDENTIAL_NOT_FOUND"
				| "CREDENTIAL_REVOKED"
				| "CREDENTIAL_STATE_CHANGED"
				| "COUNTER_REGRESSION"
				| "DECISION_CONFLICT"
				| "DECISION_IDEMPOTENCY_CONFLICT";
	  };

export type FindDecisionResult =
	| { ok: true; receipt: ApprovalReceipt }
	| { ok: false; code: "DECISION_IDEMPOTENCY_CONFLICT" }
	| null;

export interface ApproverAuditEvent {
	sequence: number;
	eventType: string;
	actorRealm: "access" | "approver" | "system";
	actorIdentity: string;
	subject: string;
	reasonCode: string | null;
	createdAt: number;
}

export interface CleanupResult {
	challenges: number;
	identities: number;
	sessions: number;
}

interface ApproverRow {
	[key: string]: string | number | ArrayBuffer | null;
	did: string;
	status: "active" | "suspended";
	session_epoch: number;
}

interface IdentityTransactionRow {
	[key: string]: string | number | ArrayBuffer | null;
	encrypted_state: string;
	encryption_key_version: number;
	client_key_id: string;
	redirect_target: string;
	expires_at: number;
	completed_at: number | null;
}

interface EncryptionRecordRow {
	[key: string]: string | number | ArrayBuffer | null;
	cursor: string;
	envelope: string;
	key_version: number;
}

interface ApproverSessionRow {
	[key: string]: string | number | ArrayBuffer | null;
	csrf_hash: string;
	session_epoch: number;
	expires_at: number;
}

interface CredentialRow {
	[key: string]: string | number | ArrayBuffer | null;
	credential_id: string;
	public_key: ArrayBuffer;
	algorithm: number;
	signature_counter: number;
	transports_json: string;
	name: string;
	created_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
}

interface CredentialListRow {
	[key: string]: string | number | ArrayBuffer | null;
	credential_id: string;
	transports_json: string;
	name: string;
	created_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
}

interface EnrollmentStatusRow {
	[key: string]: string | number | ArrayBuffer | null;
	credential_count: number;
	active_credential_count: number;
	first_enrolled_at: number | null;
	last_enrolled_at: number | null;
	last_revoked_at: number | null;
}

interface ChallengeRow {
	[key: string]: string | number | ArrayBuffer | null;
	kind: "registration" | "approval";
	intent_id: string | null;
	publisher_did: string | null;
	approval_digest: string | null;
	context: string;
	expires_at: number;
	consumed_at: number | null;
}

interface DecisionRow {
	[key: string]: string | number | ArrayBuffer | null;
	idempotency_key: string;
	intent_id: string;
	publisher_did: string;
	approval_digest: string;
	decision: ApprovalDecision;
	credential_id: string;
	verified_at: number;
}

interface AuditRow {
	[key: string]: string | number | ArrayBuffer | null;
	sequence: number;
	event_type: string;
	actor_realm: "access" | "approver" | "system";
	actor_identity: string;
	subject: string;
	reason_code: string | null;
	created_at: number;
}

function validInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

function validPositiveInteger(value: unknown): value is number {
	return validInteger(value) && value >= 1;
}

function validDid(value: unknown): value is string {
	return typeof value === "string" && value.length <= 2048 && DID_PATTERN.test(value);
}

function validHash(value: unknown): value is string {
	return typeof value === "string" && HASH_PATTERN.test(value);
}

function validCredentialId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= 1024 &&
		BASE64URL_PATTERN.test(value)
	);
}

function validBoundedString(value: unknown, maximum: number): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function validRedirectTarget(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= 2048 &&
		value.startsWith("/") &&
		!value.startsWith("//")
	);
}

function isAuthenticatorTransport(value: unknown): value is AuthenticatorTransport {
	return (
		value === "usb" ||
		value === "nfc" ||
		value === "ble" ||
		value === "internal" ||
		value === "hybrid"
	);
}

function parseTransports(value: string): AuthenticatorTransport[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new ApproverStoreError("APPROVER_INPUT_INVALID");
	}
	if (!Array.isArray(parsed) || !parsed.every(isAuthenticatorTransport)) {
		throw new ApproverStoreError("APPROVER_INPUT_INVALID");
	}
	return parsed;
}

function credentialView(row: CredentialListRow): ApproverCredential {
	return {
		id: row.credential_id,
		name: row.name,
		transports: parseTransports(row.transports_json),
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
		revokedAt: row.revoked_at,
	};
}

function decisionReceipt(row: DecisionRow, approverDid: string): ApprovalReceipt {
	return {
		approverDid,
		publisherDid: row.publisher_did,
		intentId: row.intent_id,
		approvalDigest: row.approval_digest,
		decision: row.decision,
		credentialId: row.credential_id,
		verifiedAt: row.verified_at,
	};
}

function auditView(row: AuditRow): ApproverAuditEvent {
	return {
		sequence: row.sequence,
		eventType: row.event_type,
		actorRealm: row.actor_realm,
		actorIdentity: row.actor_identity,
		subject: row.subject,
		reasonCode: row.reason_code,
		createdAt: row.created_at,
	};
}

export class ApproverStore {
	constructor(private readonly storage: DurableObjectStorage) {}

	initialize(approverDid: string, now = Date.now()): void {
		if (!validDid(approverDid) || !validInteger(now)) {
			throw new ApproverStoreError("APPROVER_DID_INVALID");
		}
		const existing = this.#readOwner();
		if (existing && existing.did !== approverDid) {
			throw new ApproverStoreError("APPROVER_DID_MISMATCH");
		}
		if (!existing) {
			this.storage.sql.exec(
				"INSERT INTO approver (id, did, created_at, updated_at) VALUES (1, ?, ?, ?)",
				approverDid,
				now,
				now,
			);
		}
	}

	putIdentityTransaction(input: PutIdentityTransactionInput): PutIdentityTransactionResult {
		this.#assertOwner(input.approverDid);
		const now = input.now ?? Date.now();
		if (
			!validHash(input.stateHash) ||
			!validBoundedString(input.encryptedState, MAX_CIPHERTEXT_CHARS) ||
			!validPositiveInteger(input.encryptionKeyVersion) ||
			!validBoundedString(input.clientKeyId, 128) ||
			!validRedirectTarget(input.redirectTarget) ||
			!validInteger(now) ||
			!validInteger(input.expiresAt) ||
			input.expiresAt <= now ||
			input.expiresAt - now > MAX_IDENTITY_TRANSACTION_MS
		) {
			throw new ApproverStoreError("APPROVER_INPUT_INVALID");
		}
		return this.storage.transactionSync(() => {
			const existing = this.storage.sql
				.exec<{ state_hash: string }>(
					"SELECT state_hash FROM identity_transactions WHERE state_hash = ?",
					input.stateHash,
				)
				.toArray()[0];
			if (existing) return { ok: false, code: "IDENTITY_TRANSACTION_EXISTS" } as const;
			this.#deleteExpiredIdentityTransactions(now, MAX_ACTIVE_IDENTITY_TRANSACTIONS);
			this.storage.sql.exec("DELETE FROM identity_transactions WHERE completed_at IS NOT NULL");
			const count = this.storage.sql
				.exec<{ count: number }>(
					"SELECT COUNT(*) AS count FROM identity_transactions WHERE completed_at IS NULL",
				)
				.one().count;
			if (count >= MAX_ACTIVE_IDENTITY_TRANSACTIONS) {
				return { ok: false, code: "IDENTITY_TRANSACTION_LIMIT_REACHED" } as const;
			}
			this.storage.sql.exec(
				`INSERT INTO identity_transactions (
					state_hash, encrypted_state, encryption_key_version, client_key_id,
					redirect_target, expires_at, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				input.stateHash,
				input.encryptedState,
				input.encryptionKeyVersion,
				input.clientKeyId,
				input.redirectTarget,
				input.expiresAt,
				now,
			);
			this.#putDeadline("identity", input.stateHash, input.expiresAt);
			this.#appendAudit("identity-transaction-created", input.approverDid, input.stateHash, now);
			return { ok: true } as const;
		});
	}

	consumeIdentityTransaction(
		approverDid: string,
		stateHash: string,
		now = Date.now(),
	): StoredIdentityTransaction | null {
		this.#assertOwner(approverDid);
		if (!validHash(stateHash) || !validInteger(now)) {
			throw new ApproverStoreError("APPROVER_INPUT_INVALID");
		}
		return this.storage.transactionSync(() => {
			const row = this.storage.sql
				.exec<IdentityTransactionRow>(
					`SELECT encrypted_state, encryption_key_version, client_key_id,
					        redirect_target, expires_at, completed_at
					 FROM identity_transactions WHERE state_hash = ?`,
					stateHash,
				)
				.toArray()[0];
			if (!row || row.completed_at !== null) return null;
			this.storage.sql.exec(
				`UPDATE identity_transactions
				 SET encrypted_state = '', completed_at = ? WHERE state_hash = ?`,
				now,
				stateHash,
			);
			this.#putDeadline("identity", stateHash, now + COMPLETED_IDENTITY_RETENTION_MS);
			if (row.expires_at <= now) {
				this.#appendAudit(
					"identity-transaction-expired",
					"system",
					stateHash,
					now,
					"IDENTITY_TRANSACTION_EXPIRED",
				);
				return null;
			}
			this.#appendAudit("identity-transaction-consumed", approverDid, stateHash, now);
			return {
				encryptedState: row.encrypted_state,
				encryptionKeyVersion: row.encryption_key_version,
				clientKeyId: row.client_key_id,
				redirectTarget: row.redirect_target,
				expiresAt: row.expires_at,
			};
		});
	}

	createSession(input: CreateApproverSessionInput): CreateApproverSessionResult {
		this.#assertOwner(input.approverDid);
		const now = input.now ?? Date.now();
		if (
			!validHash(input.tokenHash) ||
			!validHash(input.csrfHash) ||
			!validInteger(now) ||
			!validInteger(input.expiresAt) ||
			input.expiresAt <= now ||
			input.expiresAt - now > MAX_SESSION_MS
		) {
			throw new ApproverStoreError("APPROVER_INPUT_INVALID");
		}
		return this.storage.transactionSync(() => {
			const owner = this.#requireOwner(input.approverDid);
			if (owner.status === "suspended") {
				return { ok: false, code: "APPROVER_SUSPENDED" } as const;
			}
			const existing = this.storage.sql
				.exec<{ token_hash: string }>(
					"SELECT token_hash FROM approver_sessions WHERE token_hash = ?",
					input.tokenHash,
				)
				.toArray()[0];
			if (existing) return { ok: false, code: "APPROVER_SESSION_EXISTS" } as const;
			this.#deleteExpiredSessions(now, MAX_ACTIVE_SESSIONS);
			const count = this.storage.sql
				.exec<{ count: number }>("SELECT COUNT(*) AS count FROM approver_sessions")
				.one().count;
			if (count >= MAX_ACTIVE_SESSIONS) {
				return { ok: false, code: "APPROVER_SESSION_LIMIT_REACHED" } as const;
			}
			this.storage.sql.exec(
				`INSERT INTO approver_sessions (
					token_hash, csrf_hash, session_epoch, expires_at, created_at, last_seen_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				input.tokenHash,
				input.csrfHash,
				owner.session_epoch,
				input.expiresAt,
				now,
				now,
			);
			this.#putDeadline("session", input.tokenHash, input.expiresAt);
			this.#appendAudit("approver-session-created", input.approverDid, input.tokenHash, now);
			return {
				ok: true,
				session: {
					approverDid: input.approverDid,
					expiresAt: input.expiresAt,
					sessionEpoch: owner.session_epoch,
				},
			} as const;
		});
	}

	validateSession(
		approverDid: string,
		tokenHash: string,
		csrfHash: string | null,
		now = Date.now(),
	): ValidateApproverSessionResult {
		if (
			!validDid(approverDid) ||
			!validHash(tokenHash) ||
			(csrfHash !== null && !validHash(csrfHash)) ||
			!validInteger(now)
		) {
			return { ok: false, code: "APPROVER_SESSION_INVALID" };
		}
		return this.storage.transactionSync(() => {
			const owner = this.#readOwner();
			if (!owner || owner.did !== approverDid) {
				return { ok: false, code: "APPROVER_SESSION_INVALID" } as const;
			}
			if (owner.status === "suspended") {
				return { ok: false, code: "APPROVER_SUSPENDED" } as const;
			}
			const session = this.storage.sql
				.exec<ApproverSessionRow>(
					`SELECT csrf_hash, session_epoch, expires_at
					 FROM approver_sessions WHERE token_hash = ?`,
					tokenHash,
				)
				.toArray()[0];
			if (!session || session.session_epoch !== owner.session_epoch) {
				return { ok: false, code: "APPROVER_SESSION_INVALID" } as const;
			}
			if (session.expires_at <= now) {
				this.storage.sql.exec("DELETE FROM approver_sessions WHERE token_hash = ?", tokenHash);
				this.#deleteDeadline("session", tokenHash);
				return { ok: false, code: "APPROVER_SESSION_EXPIRED" } as const;
			}
			if (csrfHash !== null && session.csrf_hash !== csrfHash) {
				return { ok: false, code: "APPROVER_SESSION_INVALID" } as const;
			}
			this.storage.sql.exec(
				"UPDATE approver_sessions SET last_seen_at = ? WHERE token_hash = ?",
				now,
				tokenHash,
			);
			return {
				ok: true,
				session: {
					approverDid,
					expiresAt: session.expires_at,
					sessionEpoch: session.session_epoch,
				},
			} as const;
		});
	}

	revokeSession(approverDid: string, tokenHash: string, now = Date.now()): boolean {
		this.#assertOwner(approverDid);
		if (!validHash(tokenHash) || !validInteger(now)) return false;
		return this.storage.transactionSync(() => {
			const deleted = this.storage.sql
				.exec("DELETE FROM approver_sessions WHERE token_hash = ? RETURNING token_hash", tokenHash)
				.toArray();
			if (deleted.length === 0) return false;
			this.#deleteDeadline("session", tokenHash);
			this.#appendAudit("approver-session-revoked", approverDid, tokenHash, now);
			return true;
		});
	}

	revokeAllSessions(approverDid: string, now = Date.now()): number {
		this.#assertOwner(approverDid);
		if (!validInteger(now)) throw new ApproverStoreError("APPROVER_INPUT_INVALID");
		return this.storage.transactionSync(() => {
			const owner = this.#requireOwner(approverDid);
			const nextEpoch = owner.session_epoch + 1;
			this.storage.sql.exec(
				"UPDATE approver SET session_epoch = ?, updated_at = ? WHERE id = 1",
				nextEpoch,
				now,
			);
			this.storage.sql.exec("DELETE FROM approver_sessions");
			this.storage.sql.exec("DELETE FROM deadlines WHERE kind = 'session'");
			this.#appendAudit("approver-sessions-revoked", approverDid, approverDid, now);
			return nextEpoch;
		});
	}

	enrolCredential(approverDid: string, input: EnrolCredentialInput): EnrolCredentialResult {
		this.#assertOwner(approverDid);
		const now = input.now ?? Date.now();
		if (
			!validCredentialId(input.credentialId) ||
			!(input.publicKey instanceof Uint8Array) ||
			input.publicKey.byteLength < 1 ||
			input.publicKey.byteLength > MAX_PUBLIC_KEY_BYTES ||
			!ALGORITHMS.has(input.algorithm) ||
			!validInteger(input.counter) ||
			input.counter < 0 ||
			!Array.isArray(input.transports) ||
			!input.transports.every(isAuthenticatorTransport) ||
			new Set(input.transports).size !== input.transports.length ||
			!validBoundedString(input.name, 100) ||
			input.name.trim() !== input.name ||
			!validInteger(now)
		) {
			throw new ApproverStoreError("APPROVER_INPUT_INVALID");
		}
		return this.storage.transactionSync(() => {
			const existing = this.#readCredential(input.credentialId);
			if (existing) return { ok: false, code: "CREDENTIAL_EXISTS" } as const;
			const count = this.storage.sql
				.exec<{ count: number }>(
					"SELECT COUNT(*) AS count FROM credentials WHERE revoked_at IS NULL",
				)
				.one().count;
			if (count >= MAX_ACTIVE_CREDENTIALS) {
				return { ok: false, code: "CREDENTIAL_LIMIT_REACHED" } as const;
			}
			this.storage.sql.exec(
				`INSERT INTO credentials (
					credential_id, public_key, algorithm, signature_counter,
					transports_json, name, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				input.credentialId,
				input.publicKey.slice().buffer,
				input.algorithm,
				input.counter,
				JSON.stringify(input.transports),
				input.name,
				now,
			);
			this.#appendAudit("credential-enrolled", approverDid, input.credentialId, now);
			return {
				ok: true,
				credential: credentialView(this.#requireCredential(input.credentialId)),
			} as const;
		});
	}

	listCredentials(
		approverDid: string,
		afterCredentialId: string | null,
		limit: number,
	): readonly ApproverCredential[] {
		this.#assertOwner(approverDid);
		if (
			(afterCredentialId !== null && !validCredentialId(afterCredentialId)) ||
			!validInteger(limit) ||
			limit < 1 ||
			limit > 100
		) {
			throw new ApproverStoreError("APPROVER_INPUT_INVALID");
		}
		const rows =
			afterCredentialId === null
				? this.storage.sql
						.exec<CredentialListRow>(
							`SELECT credential_id, transports_json, name,
							        created_at, last_used_at, revoked_at
							 FROM credentials ORDER BY credential_id LIMIT ?`,
							limit,
						)
						.toArray()
				: this.storage.sql
						.exec<CredentialListRow>(
							`SELECT credential_id, transports_json, name,
							        created_at, last_used_at, revoked_at
							 FROM credentials WHERE credential_id > ?
							 ORDER BY credential_id LIMIT ?`,
							afterCredentialId,
							limit,
						)
						.toArray();
		return rows.map(credentialView);
	}

	getEnrollmentStatus(approverDid: string): ApproverEnrollmentStatus {
		if (!validDid(approverDid)) {
			throw new ApproverStoreError("APPROVER_DID_INVALID");
		}
		const owner = this.#readOwner();
		if (!owner) {
			return {
				credentialCount: 0,
				activeCredentialCount: 0,
				firstEnrolledAt: null,
				lastEnrolledAt: null,
				lastRevokedAt: null,
			};
		}
		if (owner.did !== approverDid) {
			throw new ApproverStoreError("APPROVER_DID_MISMATCH");
		}
		const row = this.storage.sql
			.exec<EnrollmentStatusRow>(
				`SELECT COUNT(*) AS credential_count,
				        COALESCE(SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END), 0)
				          AS active_credential_count,
				        MIN(created_at) AS first_enrolled_at,
				        MAX(created_at) AS last_enrolled_at,
				        MAX(revoked_at) AS last_revoked_at
				 FROM credentials`,
			)
			.one();
		return {
			credentialCount: row.credential_count,
			activeCredentialCount: row.active_credential_count,
			firstEnrolledAt: row.first_enrolled_at,
			lastEnrolledAt: row.last_enrolled_at,
			lastRevokedAt: row.last_revoked_at,
		};
	}

	getCredentialForVerification(
		approverDid: string,
		credentialId: string,
	): CredentialVerificationMaterial | null {
		this.#assertOwner(approverDid);
		if (!validCredentialId(credentialId)) {
			throw new ApproverStoreError("APPROVER_INPUT_INVALID");
		}
		const row = this.#readCredential(credentialId);
		if (!row || row.revoked_at !== null) return null;
		return {
			id: row.credential_id,
			publicKey: new Uint8Array(row.public_key),
			algorithm: row.algorithm,
			counter: row.signature_counter,
			transports: parseTransports(row.transports_json),
		};
	}

	revokeCredential(
		approverDid: string,
		credentialId: string,
		now = Date.now(),
	): RevokeCredentialResult {
		this.#assertOwner(approverDid);
		if (!validCredentialId(credentialId) || !validInteger(now)) {
			throw new ApproverStoreError("APPROVER_INPUT_INVALID");
		}
		return this.storage.transactionSync(() => {
			const row = this.#readCredential(credentialId);
			if (!row) return { ok: false, code: "CREDENTIAL_NOT_FOUND" } as const;
			if (row.revoked_at !== null) return { ok: false, code: "CREDENTIAL_REVOKED" } as const;
			this.storage.sql.exec(
				"UPDATE credentials SET revoked_at = ? WHERE credential_id = ?",
				now,
				credentialId,
			);
			this.#invalidateAllChallenges(now, "CREDENTIAL_REVOKED");
			this.#appendAudit("credential-revoked", approverDid, credentialId, now);
			return {
				ok: true,
				credential: credentialView(this.#requireCredential(credentialId)),
			} as const;
		});
	}

	commitCredentialUse(
		approverDid: string,
		credentialId: string,
		expectedCounter: number,
		newCounter: number,
		now = Date.now(),
	): CommitCredentialUseResult {
		this.#assertOwner(approverDid);
		if (
			!validCredentialId(credentialId) ||
			!validInteger(expectedCounter) ||
			expectedCounter < 0 ||
			!validInteger(newCounter) ||
			newCounter < 0 ||
			!validInteger(now)
		) {
			throw new ApproverStoreError("APPROVER_INPUT_INVALID");
		}
		return this.storage.transactionSync(() => {
			const row = this.#readCredential(credentialId);
			if (!row) return { ok: false, code: "CREDENTIAL_NOT_FOUND" } as const;
			if (row.revoked_at !== null) return { ok: false, code: "CREDENTIAL_REVOKED" } as const;
			if (row.signature_counter !== expectedCounter) {
				return { ok: false, code: "CREDENTIAL_STATE_CHANGED" } as const;
			}
			if ((newCounter > 0 || expectedCounter > 0) && newCounter <= expectedCounter) {
				this.#appendAudit(
					"credential-counter-regression",
					approverDid,
					credentialId,
					now,
					"COUNTER_REGRESSION",
				);
				return { ok: false, code: "COUNTER_REGRESSION" } as const;
			}
			this.storage.sql.exec(
				`UPDATE credentials SET signature_counter = ?, last_used_at = ?
				 WHERE credential_id = ? AND signature_counter = ? AND revoked_at IS NULL`,
				newCounter,
				now,
				credentialId,
				expectedCounter,
			);
			this.#appendAudit("credential-used", approverDid, credentialId, now);
			return { ok: true, counter: newCounter } as const;
		});
	}

	createChallenge(approverDid: string, input: CreateChallengeInput): CreateChallengeResult {
		this.#assertOwner(approverDid);
		const now = input.now ?? Date.now();
		if (!this.#validChallenge(input, now)) {
			throw new ApproverStoreError("APPROVER_INPUT_INVALID");
		}
		return this.storage.transactionSync(() => {
			const existing = this.storage.sql
				.exec<{ challenge_hash: string }>(
					"SELECT challenge_hash FROM approval_challenges WHERE challenge_hash = ?",
					input.challengeHash,
				)
				.toArray()[0];
			if (existing) return { ok: false, code: "CHALLENGE_EXISTS" } as const;
			this.#expireChallenges(now, MAX_ACTIVE_CHALLENGES);
			this.storage.sql.exec("DELETE FROM approval_challenges WHERE consumed_at IS NOT NULL");
			const count = this.storage.sql
				.exec<{ count: number }>(
					"SELECT COUNT(*) AS count FROM approval_challenges WHERE consumed_at IS NULL",
				)
				.one().count;
			if (count >= MAX_ACTIVE_CHALLENGES) {
				return { ok: false, code: "CHALLENGE_LIMIT_REACHED" } as const;
			}
			this.storage.sql.exec(
				`INSERT INTO approval_challenges (
					challenge_hash, kind, intent_id, publisher_did, approval_digest,
					context, expires_at, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				input.challengeHash,
				input.kind,
				input.intentId ?? null,
				input.publisherDid ?? null,
				input.approvalDigest ?? null,
				input.context,
				input.expiresAt,
				now,
			);
			this.#putDeadline("challenge", input.challengeHash, input.expiresAt);
			this.#appendAudit("challenge-created", approverDid, input.challengeHash, now);
			return { ok: true } as const;
		});
	}

	consumeChallenge(
		approverDid: string,
		challengeHash: string,
		expectedKind: CreateChallengeInput["kind"],
		now = Date.now(),
	): ConsumeChallengeResult {
		this.#assertOwner(approverDid);
		if (
			!validHash(challengeHash) ||
			(expectedKind !== "registration" && expectedKind !== "approval") ||
			!validInteger(now)
		) {
			throw new ApproverStoreError("APPROVER_INPUT_INVALID");
		}
		return this.storage.transactionSync(() => {
			const row = this.storage.sql
				.exec<ChallengeRow>(
					`SELECT kind, intent_id, publisher_did, approval_digest,
					        context, expires_at, consumed_at
					 FROM approval_challenges WHERE challenge_hash = ?`,
					challengeHash,
				)
				.toArray()[0];
			if (!row || row.kind !== expectedKind) {
				return { ok: false, code: "CHALLENGE_NOT_FOUND" } as const;
			}
			if (row.consumed_at !== null) {
				return { ok: false, code: "CHALLENGE_CONSUMED" } as const;
			}
			this.storage.sql.exec(
				"UPDATE approval_challenges SET consumed_at = ? WHERE challenge_hash = ?",
				now,
				challengeHash,
			);
			this.#deleteDeadline("challenge", challengeHash);
			if (row.expires_at <= now) {
				this.#appendAudit("challenge-expired", "system", challengeHash, now, "CHALLENGE_EXPIRED");
				return { ok: false, code: "CHALLENGE_EXPIRED" } as const;
			}
			this.#appendAudit("challenge-consumed", approverDid, challengeHash, now);
			return {
				ok: true,
				challenge: {
					kind: row.kind,
					intentId: row.intent_id,
					publisherDid: row.publisher_did,
					approvalDigest: row.approval_digest,
					context: row.context,
					expiresAt: row.expires_at,
				},
			} as const;
		});
	}

	invalidateIntentChallenges(
		approverDid: string,
		intentId: string,
		reasonCode: string,
		now = Date.now(),
	): number {
		this.#assertOwner(approverDid);
		if (
			!ULID_PATTERN.test(intentId) ||
			!validBoundedString(reasonCode, 128) ||
			!validInteger(now)
		) {
			throw new ApproverStoreError("APPROVER_INPUT_INVALID");
		}
		return this.storage.transactionSync(() =>
			this.#invalidateIntentChallenges(intentId, now, reasonCode),
		);
	}

	findDecision(approverDid: string, input: DecisionIdentity): FindDecisionResult {
		this.#assertOwner(approverDid);
		if (!this.#validDecisionIdentity(input)) {
			throw new ApproverStoreError("APPROVER_INPUT_INVALID");
		}
		return this.#findDecision(input, approverDid);
	}

	commitVerifiedDecision(
		approverDid: string,
		input: CommitVerifiedDecisionInput,
	): RecordDecisionResult {
		this.#assertOwner(approverDid);
		if (
			!this.#validDecision(input) ||
			!validInteger(input.expectedCounter) ||
			input.expectedCounter < 0 ||
			!validInteger(input.newCounter) ||
			input.newCounter < 0
		) {
			throw new ApproverStoreError("APPROVER_INPUT_INVALID");
		}
		return this.storage.transactionSync(() => {
			const replay = this.#findDecision(input, approverDid);
			if (replay) {
				if (!replay.ok) return replay;
				return { ok: true, receipt: replay.receipt, replayed: true } as const;
			}
			if (this.#readDecision(input.intentId, input.approvalDigest)) {
				return { ok: false, code: "DECISION_CONFLICT" } as const;
			}
			const credential = this.#readCredential(input.credentialId);
			if (!credential) return { ok: false, code: "CREDENTIAL_NOT_FOUND" } as const;
			if (credential.revoked_at !== null) {
				return { ok: false, code: "CREDENTIAL_REVOKED" } as const;
			}
			if (credential.signature_counter !== input.expectedCounter) {
				return { ok: false, code: "CREDENTIAL_STATE_CHANGED" } as const;
			}
			if (
				(input.newCounter > 0 || input.expectedCounter > 0) &&
				input.newCounter <= input.expectedCounter
			) {
				this.#appendAudit(
					"credential-counter-regression",
					approverDid,
					input.credentialId,
					input.verifiedAt,
					"COUNTER_REGRESSION",
				);
				return { ok: false, code: "COUNTER_REGRESSION" } as const;
			}
			this.storage.sql.exec(
				`UPDATE credentials SET signature_counter = ?, last_used_at = ?
				 WHERE credential_id = ? AND signature_counter = ? AND revoked_at IS NULL`,
				input.newCounter,
				input.verifiedAt,
				input.credentialId,
				input.expectedCounter,
			);
			this.#appendAudit("credential-used", approverDid, input.credentialId, input.verifiedAt);
			return this.#insertDecision(approverDid, input);
		});
	}

	getDecision(
		approverDid: string,
		intentId: string,
		approvalDigest: string,
	): ApprovalReceipt | null {
		this.#assertOwner(approverDid);
		if (!ULID_PATTERN.test(intentId) || !validHash(approvalDigest)) {
			throw new ApproverStoreError("APPROVER_INPUT_INVALID");
		}
		const row = this.#readDecision(intentId, approvalDigest);
		return row ? decisionReceipt(row, approverDid) : null;
	}

	listAuditEvents(
		approverDid: string,
		afterSequence: number,
		limit: number,
	): readonly ApproverAuditEvent[] {
		this.#assertOwner(approverDid);
		if (
			!validInteger(afterSequence) ||
			afterSequence < 0 ||
			!validInteger(limit) ||
			limit < 1 ||
			limit > 100
		) {
			throw new ApproverStoreError("APPROVER_INPUT_INVALID");
		}
		return this.storage.sql
			.exec<AuditRow>(
				`SELECT sequence, event_type, actor_realm, actor_identity,
				        subject, reason_code, created_at
				 FROM audit_events WHERE sequence > ? ORDER BY sequence LIMIT ?`,
				afterSequence,
				limit,
			)
			.toArray()
			.map(auditView);
	}

	listEncryptionRecords(
		approverDid: string,
		afterCursor: string | null,
		limit: number,
		now = Date.now(),
	): EncryptionRecordPage {
		this.#assertOwner(approverDid);
		if (
			(afterCursor !== null && !ENCRYPTION_CURSOR_PATTERN.test(afterCursor)) ||
			!validInteger(limit) ||
			limit < 1 ||
			limit > MAX_ENCRYPTION_RECORD_PAGE ||
			!validInteger(now) ||
			now < 0
		) {
			throw new ApproverStoreError("APPROVER_INPUT_INVALID");
		}
		const rows = this.storage.sql
			.exec<EncryptionRecordRow>(
				`SELECT 'identity-transaction:' || state_hash AS cursor,
				        encrypted_state AS envelope, encryption_key_version AS key_version
				 FROM identity_transactions
				 WHERE completed_at IS NULL AND expires_at > ? AND encrypted_state != ''
				   AND ('identity-transaction:' || state_hash) > ?
				 ORDER BY state_hash LIMIT ?`,
				now,
				afterCursor ?? "",
				limit + 1,
			)
			.toArray();
		const hasMore = rows.length > limit;
		const visible = hasMore ? rows.slice(0, limit) : rows;
		const items = visible.map((row) => ({
			cursor: row.cursor,
			envelope: row.envelope,
			keyVersion: row.key_version,
			context: {
				purpose: "oauth-approver-transaction" as const,
				objectClass: "ApproverDurableObject",
				table: "identity_transactions",
				primaryKey: row.cursor.slice("identity-transaction:".length),
				ownerDid: approverDid,
			},
		}));
		return {
			items,
			nextCursor: hasMore ? (items.at(-1)?.cursor ?? null) : null,
		};
	}

	replaceEncryptionRecord(input: EncryptionRecordReplacement & { approverDid: string }): boolean {
		this.#assertOwner(input.approverDid);
		const now = input.now ?? Date.now();
		if (
			!ENCRYPTION_CURSOR_PATTERN.test(input.cursor) ||
			!validBoundedString(input.expectedEnvelope, MAX_CIPHERTEXT_CHARS) ||
			!validBoundedString(input.replacementEnvelope, MAX_CIPHERTEXT_CHARS) ||
			!validPositiveInteger(input.replacementKeyVersion) ||
			!ACTOR_IDENTITY_PATTERN.test(input.actorIdentity) ||
			!validInteger(now) ||
			now < 0
		) {
			throw new ApproverStoreError("APPROVER_INPUT_INVALID");
		}
		return this.storage.transactionSync(() => {
			const result = this.storage.sql.exec(
				`UPDATE identity_transactions
				 SET encrypted_state = ?, encryption_key_version = ?
				 WHERE state_hash = ? AND encrypted_state = ?
				   AND completed_at IS NULL AND expires_at > ?`,
				input.replacementEnvelope,
				input.replacementKeyVersion,
				input.cursor.slice("identity-transaction:".length),
				input.expectedEnvelope,
				now,
			);
			if (result.rowsWritten !== 1) return false;
			this.storage.sql.exec(
				`INSERT INTO audit_events (
					event_type, actor_realm, actor_identity, subject,
					reason_code, public_payload, created_at
				) VALUES ('encryption-rotated', 'access', ?, ?, NULL, '{}', ?)`,
				input.actorIdentity,
				input.cursor,
				now,
			);
			return true;
		});
	}

	cleanupExpired(now = Date.now(), limit = 100): CleanupResult {
		if (!validInteger(now) || !validInteger(limit) || limit < 1 || limit > 1000) {
			throw new ApproverStoreError("APPROVER_INPUT_INVALID");
		}
		return this.storage.transactionSync(() => ({
			challenges: this.#expireChallenges(now, limit),
			identities: this.#deleteExpiredIdentityTransactions(now, limit),
			sessions: this.#deleteExpiredSessions(now, limit),
		}));
	}

	nextDeadline(): number | null {
		return (
			this.storage.sql
				.exec<{ scheduled_at: number }>(
					"SELECT scheduled_at FROM deadlines ORDER BY scheduled_at, kind, subject_id LIMIT 1",
				)
				.toArray()[0]?.scheduled_at ?? null
		);
	}

	#readOwner(): ApproverRow | null {
		return (
			this.storage.sql
				.exec<ApproverRow>("SELECT did, status, session_epoch FROM approver WHERE id = 1")
				.toArray()[0] ?? null
		);
	}

	#requireOwner(approverDid: string): ApproverRow {
		const owner = this.#readOwner();
		if (!owner || owner.did !== approverDid) {
			throw new ApproverStoreError("APPROVER_DID_MISMATCH");
		}
		return owner;
	}

	#assertOwner(approverDid: string): void {
		if (!validDid(approverDid)) {
			throw new ApproverStoreError("APPROVER_DID_INVALID");
		}
		this.#requireOwner(approverDid);
	}

	#readCredential(credentialId: string): CredentialRow | null {
		return (
			this.storage.sql
				.exec<CredentialRow>(
					`SELECT credential_id, public_key, algorithm, signature_counter,
					        transports_json, name, created_at, last_used_at, revoked_at
					 FROM credentials WHERE credential_id = ?`,
					credentialId,
				)
				.toArray()[0] ?? null
		);
	}

	#requireCredential(credentialId: string): CredentialRow {
		const credential = this.#readCredential(credentialId);
		if (!credential) throw new ApproverStoreError("APPROVER_INPUT_INVALID");
		return credential;
	}

	#readDecision(intentId: string, approvalDigest: string): DecisionRow | null {
		return (
			this.storage.sql
				.exec<DecisionRow>(
					`SELECT idempotency_key, intent_id, publisher_did, approval_digest,
					        decision, credential_id, verified_at
					 FROM decisions WHERE intent_id = ? AND approval_digest = ?`,
					intentId,
					approvalDigest,
				)
				.toArray()[0] ?? null
		);
	}

	#readDecisionByKey(idempotencyKey: string): DecisionRow | null {
		return (
			this.storage.sql
				.exec<DecisionRow>(
					`SELECT idempotency_key, intent_id, publisher_did, approval_digest,
					        decision, credential_id, verified_at
					 FROM decisions WHERE idempotency_key = ?`,
					idempotencyKey,
				)
				.toArray()[0] ?? null
		);
	}

	#validChallenge(input: CreateChallengeInput, now: number): boolean {
		if (
			!validHash(input.challengeHash) ||
			!validInteger(now) ||
			!validInteger(input.expiresAt) ||
			input.expiresAt <= now ||
			input.expiresAt - now > MAX_CHALLENGE_MS + MAX_CHALLENGE_CLOCK_SKEW_MS ||
			!validBoundedString(input.context, MAX_CONTEXT_CHARS)
		) {
			return false;
		}
		if (input.kind === "registration") {
			return (
				input.intentId === undefined &&
				input.publisherDid === undefined &&
				input.approvalDigest === undefined
			);
		}
		return (
			ULID_PATTERN.test(input.intentId ?? "") &&
			validDid(input.publisherDid) &&
			validHash(input.approvalDigest)
		);
	}

	#validDecision(input: RecordDecisionInput): boolean {
		return this.#validDecisionIdentity(input) && validPositiveInteger(input.verifiedAt);
	}

	#validDecisionIdentity(input: DecisionIdentity): boolean {
		return (
			IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) &&
			ULID_PATTERN.test(input.intentId) &&
			validDid(input.publisherDid) &&
			validHash(input.approvalDigest) &&
			(input.decision === "approve" || input.decision === "reject") &&
			validCredentialId(input.credentialId)
		);
	}

	#findDecision(input: DecisionIdentity, approverDid: string): FindDecisionResult {
		const existing = this.#readDecisionByKey(input.idempotencyKey);
		if (!existing) return null;
		if (
			existing.intent_id !== input.intentId ||
			existing.publisher_did !== input.publisherDid ||
			existing.approval_digest !== input.approvalDigest ||
			existing.decision !== input.decision ||
			existing.credential_id !== input.credentialId
		) {
			return { ok: false, code: "DECISION_IDEMPOTENCY_CONFLICT" };
		}
		return { ok: true, receipt: decisionReceipt(existing, approverDid) };
	}

	#insertDecision(
		approverDid: string,
		input: RecordDecisionInput,
	): Extract<RecordDecisionResult, { ok: true }> {
		const receipt: ApprovalReceipt = {
			approverDid,
			publisherDid: input.publisherDid,
			intentId: input.intentId,
			approvalDigest: input.approvalDigest,
			decision: input.decision,
			credentialId: input.credentialId,
			verifiedAt: input.verifiedAt,
		};
		this.storage.sql.exec(
			`INSERT INTO decisions (
				idempotency_key, intent_id, publisher_did, approval_digest,
				decision, credential_id, verified_at, receipt_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			input.idempotencyKey,
			input.intentId,
			input.publisherDid,
			input.approvalDigest,
			input.decision,
			input.credentialId,
			input.verifiedAt,
			JSON.stringify(receipt),
		);
		this.#invalidateIntentChallenges(input.intentId, input.verifiedAt, "DECISION_RECORDED");
		this.#appendAudit(
			"approval-decision-recorded",
			approverDid,
			input.intentId,
			input.verifiedAt,
			input.decision === "approve" ? "APPROVED" : "REJECTED",
		);
		return { ok: true, receipt, replayed: false };
	}

	#putDeadline(kind: "challenge" | "session" | "identity", subjectId: string, at: number): void {
		this.storage.sql.exec(
			`INSERT INTO deadlines (kind, subject_id, generation, scheduled_at)
			 VALUES (?, ?, 1, ?)
			 ON CONFLICT(kind, subject_id) DO UPDATE SET
				generation = deadlines.generation + 1,
				scheduled_at = excluded.scheduled_at`,
			kind,
			subjectId,
			at,
		);
	}

	#deleteDeadline(kind: "challenge" | "session" | "identity", subjectId: string): void {
		this.storage.sql.exec(
			"DELETE FROM deadlines WHERE kind = ? AND subject_id = ?",
			kind,
			subjectId,
		);
	}

	#deleteExpiredIdentityTransactions(now: number, limit: number): number {
		const rows = this.storage.sql
			.exec<{ state_hash: string; completed_at: number | null }>(
				`SELECT state_hash, completed_at FROM identity_transactions
				 WHERE expires_at <= ? OR (completed_at IS NOT NULL AND completed_at <= ?)
				 ORDER BY expires_at, state_hash LIMIT ?`,
				now,
				now - COMPLETED_IDENTITY_RETENTION_MS,
				limit,
			)
			.toArray();
		for (const row of rows) {
			this.storage.sql.exec(
				"DELETE FROM identity_transactions WHERE state_hash = ?",
				row.state_hash,
			);
			this.#deleteDeadline("identity", row.state_hash);
			if (row.completed_at === null) {
				this.#appendAudit(
					"identity-transaction-expired",
					"system",
					row.state_hash,
					now,
					"IDENTITY_TRANSACTION_EXPIRED",
				);
			}
		}
		return rows.length;
	}

	#deleteExpiredSessions(now: number, limit: number): number {
		const rows = this.storage.sql
			.exec<{ token_hash: string }>(
				`SELECT token_hash FROM approver_sessions
				 WHERE expires_at <= ? ORDER BY expires_at, token_hash LIMIT ?`,
				now,
				limit,
			)
			.toArray();
		for (const row of rows) {
			this.storage.sql.exec("DELETE FROM approver_sessions WHERE token_hash = ?", row.token_hash);
			this.#deleteDeadline("session", row.token_hash);
		}
		return rows.length;
	}

	#expireChallenges(now: number, limit: number): number {
		const rows = this.storage.sql
			.exec<{ challenge_hash: string }>(
				`SELECT challenge_hash FROM approval_challenges
				 WHERE consumed_at IS NULL AND expires_at <= ?
				 ORDER BY expires_at, challenge_hash LIMIT ?`,
				now,
				limit,
			)
			.toArray();
		for (const row of rows) {
			this.storage.sql.exec(
				"UPDATE approval_challenges SET consumed_at = ? WHERE challenge_hash = ?",
				now,
				row.challenge_hash,
			);
			this.#deleteDeadline("challenge", row.challenge_hash);
			this.#appendAudit(
				"challenge-expired",
				"system",
				row.challenge_hash,
				now,
				"CHALLENGE_EXPIRED",
			);
		}
		return rows.length;
	}

	#invalidateIntentChallenges(intentId: string, now: number, reasonCode: string): number {
		const rows = this.storage.sql
			.exec<{ challenge_hash: string }>(
				`SELECT challenge_hash FROM approval_challenges
				 WHERE intent_id = ? AND consumed_at IS NULL`,
				intentId,
			)
			.toArray();
		for (const row of rows) {
			this.storage.sql.exec(
				"UPDATE approval_challenges SET consumed_at = ? WHERE challenge_hash = ?",
				now,
				row.challenge_hash,
			);
			this.#deleteDeadline("challenge", row.challenge_hash);
		}
		if (rows.length > 0) {
			this.#appendAudit("challenges-invalidated", "system", intentId, now, reasonCode);
		}
		return rows.length;
	}

	#invalidateAllChallenges(now: number, reasonCode: string): void {
		const rows = this.storage.sql
			.exec<{ challenge_hash: string }>(
				"SELECT challenge_hash FROM approval_challenges WHERE consumed_at IS NULL",
			)
			.toArray();
		for (const row of rows) {
			this.storage.sql.exec(
				"UPDATE approval_challenges SET consumed_at = ? WHERE challenge_hash = ?",
				now,
				row.challenge_hash,
			);
			this.#deleteDeadline("challenge", row.challenge_hash);
		}
		if (rows.length > 0) {
			this.#appendAudit("challenges-invalidated", "system", "all", now, reasonCode);
		}
	}

	#appendAudit(
		eventType: string,
		actorIdentity: string,
		subject: string,
		createdAt: number,
		reasonCode: string | null = null,
	): void {
		const actorRealm = actorIdentity === "system" ? "system" : "approver";
		this.storage.sql.exec(
			`INSERT INTO audit_events (
				event_type, actor_realm, actor_identity, subject,
				reason_code, public_payload, created_at
			) VALUES (?, ?, ?, ?, ?, '{}', ?)`,
			eventType,
			actorRealm,
			actorIdentity,
			subject,
			reasonCode,
			createdAt,
		);
	}
}
