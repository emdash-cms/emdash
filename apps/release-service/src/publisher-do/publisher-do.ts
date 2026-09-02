import { DurableObject } from "cloudflare:workers";

import { invalidateApprovalChallenges } from "../approvals/invalidation.js";
import type {
	EncryptionRecordPage,
	EncryptionRecordReplacement,
} from "../operations/encryption-records.js";
import { MAX_ENCRYPTION_RECORD_PAGE } from "../operations/encryption-records.js";
import { parseStoredWorkloadIdentity } from "../workload/stored-identity.js";
import {
	initializeIntentStateSchema,
	IntentStateStore,
	type CreateIntentInput,
	type CreateIntentResult,
	type IntentIdempotencyMatch,
	type IntentTransition,
	type StoredIntent,
	type TransitionIntentInput,
	type TransitionIntentResult,
} from "./intent-state.js";
import {
	initializeOperationsRestoreSchema,
	OperationsRestoreStore,
	type ApplyPublisherRestorePageInput,
	type ApplyPublisherRestorePageResult,
} from "./operations-restore.js";
import {
	initializePublicationCoordinationSchema,
	PublicationCoordinationStore,
	type AcquirePublicationCoordinationResult,
	type ReleasePublicationCoordinationInput,
	type ReleasePublicationCoordinationResult,
	type RenewPublicationCoordinationInput,
	type RenewPublicationCoordinationResult,
} from "./publication-coordination.js";
import {
	initializePublicationMaterializationSchema,
	PublicationMaterializationStore,
	type CompletePublicationMaterializationInput,
	type PublicationMaterializationMutationResult,
	type PutPublicationArtifactStageInput,
	type PutPublicationBlobReceiptInput,
	type StoredPublicationMaterialization,
} from "./publication-materialization.js";
import {
	initializePublicationOperationSchema,
	PublicationOperationStore,
	type AdvancePublicationOperationPhaseInput,
	type AdvancePublicationOperationPhaseResult,
	type BeginPublicationOperationResult,
	type CompletePublicationOperationInput,
	type CompletePublicationOperationResult,
} from "./publication-operation.js";
import {
	initializeIntentRateLimitSchema,
	IntentRateLimitStore,
	type ConsumeIntentRateLimitInput,
	type ConsumeIntentRateLimitResult,
} from "./rate-limit.js";
import {
	initializeVerificationStepSchema,
	VerificationStepStore,
	type PutVerificationStepInput,
	type PutVerificationStepResult,
	type StoredVerificationStep,
	type VerificationStepName,
} from "./verification-step.js";
import {
	initializeWorkflowConnectionSchema,
	WorkflowConnectionStore,
	type CreateWorkflowConnectionInvitationInput,
	type CreateWorkflowConnectionInvitationResult as StoreWorkflowConnectionInvitationResult,
	type CreateWorkflowConnectionRequestInput,
	type RejectWorkflowConnectionRequestResult as StoreRejectWorkflowConnectionRequestResult,
	type StoredWorkflowConnectionRequest,
	type WorkflowConnectionRefScope,
	workflowConnectionPolicy,
	workflowConnectionPolicyMatches,
} from "./workflow-connection.js";
import {
	initializeWorkloadPolicySchema,
	WorkloadPolicyStore,
	type PutWorkloadPolicyInput,
	type PutWorkloadPolicyResult,
	type StoredWorkloadPolicy,
} from "./workload-policy.js";

export type {
	PutWorkloadPolicyInput,
	PutWorkloadPolicyResult,
	StoredWorkloadPolicy,
} from "./workload-policy.js";
export type {
	CreateIntentInput,
	CreateIntentResult,
	IntentState,
	IntentTransition,
	IntentIdempotencyMatch,
	StoredIntent,
	TransitionIntentInput,
	TransitionIntentResult,
} from "./intent-state.js";
export type {
	AcquirePublicationCoordinationResult,
	PublicationCoordinationLease,
	ReleasePublicationCoordinationInput,
	ReleasePublicationCoordinationResult,
	RenewPublicationCoordinationInput,
	RenewPublicationCoordinationResult,
} from "./publication-coordination.js";
export type {
	CompletePublicationMaterializationInput,
	PublicationArtifactSlot,
	PublicationBlob,
	PublicationMaterializationMutationResult,
	PutPublicationArtifactStageInput,
	PutPublicationBlobReceiptInput,
	StoredPublicationArtifact,
	StoredPublicationMaterialization,
} from "./publication-materialization.js";
export type {
	AdvancePublicationOperationPhaseInput,
	AdvancePublicationOperationPhaseResult,
	BeginPublicationOperationResult,
	CompletePublicationOperationInput,
	CompletePublicationOperationResult,
	PublicationOperationLease,
	PublicationOperationPhase,
	PublicationOutcome,
} from "./publication-operation.js";
export type {
	PutVerificationStepInput,
	PutVerificationStepResult,
	StoredVerificationStep,
	VerificationStepName,
} from "./verification-step.js";
export type {
	ApplyPublisherRestorePageInput,
	ApplyPublisherRestorePageResult,
	PublisherRestoreKind,
} from "./operations-restore.js";
export type { ConsumeIntentRateLimitInput, ConsumeIntentRateLimitResult } from "./rate-limit.js";
export type {
	CreateWorkflowConnectionInvitationInput,
	CreateWorkflowConnectionRequestInput,
	CreateWorkflowConnectionRequestResult,
	StoredWorkflowConnectionRequest,
	WorkflowConnectionClaim,
	WorkflowConnectionRefScope,
	WorkflowConnectionRequestState,
} from "./workflow-connection.js";

const DID_PATTERN = /^did:[a-z][a-z0-9]*:[A-Za-z0-9._:%-]+$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ACTOR_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const MAX_CIPHERTEXT_CHARS = 1_500_000;
const MAX_ACTIVE_OAUTH_STATES = 20;
const MAX_REFRESH_LEASE_MS = 5 * 60_000;
const MAX_PUBLISHER_SESSION_MS = 24 * 60 * 60_000;
const MAX_ACTIVE_PUBLISHER_SESSIONS = 20;
const MAINTENANCE_BATCH_SIZE = 100;
const REFRESH_TOKEN_BYTES = 32;
const BASE64_PADDING_PATTERN = /=+$/;
const ENCRYPTION_CURSOR_PATTERN = /^(?:delegation:1|oauth-state:[A-Za-z0-9_-]{32,128})$/;
const ARCHIVE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
const MAX_RESTORE_PAGES = 1_000_000;

export type PublisherOAuthEncryptionPurpose =
	| "oauth-console-transaction"
	| "oauth-delegation-transaction";

export type PublisherStateErrorCode =
	| "PUBLISHER_DID_INVALID"
	| "PUBLISHER_DID_MISMATCH"
	| "OAUTH_STATE_INVALID"
	| "OAUTH_STATE_EXISTS"
	| "DELEGATION_INVALID"
	| "DELEGATION_CAS_REQUIRED"
	| "DELEGATION_UNAVAILABLE"
	| "ENCRYPTION_OPERATION_INVALID"
	| "OPERATIONS_EXPORT_INVALID"
	| "PUBLISHER_SESSION_INVALID"
	| "PUBLISHER_STATE_CORRUPT";

export class PublisherStateError extends Error {
	readonly code: PublisherStateErrorCode;

	constructor(code: PublisherStateErrorCode) {
		super(code);
		this.name = "PublisherStateError";
		this.code = code;
	}
}

export interface PutOAuthStateInput {
	publisherDid: string;
	stateHash: string;
	encryptedState: string;
	encryptionKeyVersion: number;
	encryptionPurpose: PublisherOAuthEncryptionPurpose;
	clientKeyId: string;
	redirectTarget: string;
	expiresAt: number;
	now?: number;
}

export interface StoredOAuthState {
	encryptedState: string;
	encryptionKeyVersion: number;
	clientKeyId: string;
	redirectTarget: string;
	expiresAt: number;
}

export type PutOAuthStateResult =
	| { ok: true }
	| { ok: false; code: "OAUTH_STATE_EXISTS" | "OAUTH_STATE_LIMIT_REACHED" };

export interface PutDelegationInput {
	publisherDid: string;
	releaseNsid: string;
	scope: string;
	clientKeyId: string;
	encryptedSession: string;
	encryptionKeyVersion: number;
	issuer: string;
	pdsUrl: string;
	expiresAt: number | null;
	refreshBefore: number | null;
	expectedVersion: number | null;
}

export interface StoredDelegation {
	releaseNsid: string;
	scope: string;
	clientKeyId: string;
	encryptedSession: string;
	encryptionKeyVersion: number | null;
	issuer: string | null;
	pdsUrl: string | null;
	expiresAt: number | null;
	refreshBefore: number | null;
	status: "active" | "revoked" | "reauthorization_required";
	stateVersion: number;
}

export interface PublisherOperationsMetadata {
	publisher: {
		did: string;
		status: "active" | "suspended";
		createdAt: number;
	};
	delegation: Omit<
		StoredDelegation,
		"clientKeyId" | "encryptedSession" | "encryptionKeyVersion"
	> | null;
}

export interface PublisherAuditEvent {
	sequence: number;
	eventType: string;
	actorRealm: "access" | "approver" | "oidc" | "publisher" | "system";
	actorIdentity: string;
	subject: string;
	reasonCode: string | null;
	publicPayloadJson: string;
	createdAt: number;
}

export type PreparePublisherRestoreResult =
	| { ok: true; deletedIntents: number; deletedWorkloads: number; replayed: boolean }
	| { ok: false; code: "PUBLISHER_NOT_SUSPENDED" | "RESTORE_CONFLICT" };

export type AbortPublisherRestoreResult =
	| { ok: true; replayed: boolean }
	| { ok: false; code: "PUBLISHER_NOT_SUSPENDED" | "RESTORE_CONFLICT" };

export type PutDelegationResult =
	| { ok: true; delegation: StoredDelegation }
	| { ok: false; code: "DELEGATION_CAS_REQUIRED" };

export type RevokeDelegationResult =
	| { ok: true; delegation: StoredDelegation }
	| { ok: false; code: "DELEGATION_CAS_REQUIRED" };

export type RequireDelegationReauthorizationResult =
	| { ok: true; delegation: StoredDelegation }
	| { ok: false; code: "DELEGATION_CAS_REQUIRED" };

export type DelegationReauthorizationReason =
	| "OAUTH_CLIENT_KEY_UNAVAILABLE"
	| "OAUTH_SESSION_INVALID"
	| "ENCRYPTION_KEY_UNAVAILABLE";

export interface DelegationRefreshLease {
	generation: number;
	token: string;
	expectedVersion: number;
	expiresAt: number;
}

export type BeginDelegationRefreshResult =
	| { ok: true; lease: DelegationRefreshLease }
	| { ok: false; code: "DELEGATION_UNAVAILABLE" }
	| { ok: false; code: "DELEGATION_REFRESH_BUSY"; retryAt: number };

export interface CompleteDelegationRefreshInput {
	publisherDid: string;
	generation: number;
	token: string;
	expectedVersion: number;
	clientKeyId: string;
	encryptedSession: string;
	encryptionKeyVersion: number;
	issuer: string;
	pdsUrl: string;
	expiresAt: number | null;
	refreshBefore: number | null;
	now?: number;
}

export type CompleteDelegationRefreshResult =
	| { ok: true; delegation: StoredDelegation }
	| { ok: false; code: "DELEGATION_CAS_REQUIRED" };

interface PublisherRow {
	[key: string]: string | number | ArrayBuffer | null;
	did: string;
}

interface PublisherSessionOwnerRow {
	[key: string]: string | number | ArrayBuffer | null;
	did: string;
	status: "active" | "suspended";
	session_epoch: number;
}

interface PublisherOperationsMetadataRow {
	[key: string]: string | number | ArrayBuffer | null;
	did: string;
	status: "active" | "suspended";
	created_at: number;
}

interface PublisherSessionRow {
	[key: string]: string | number | ArrayBuffer | null;
	token_hash: string;
	csrf_hash: string;
	session_epoch: number;
	expires_at: number;
}

export interface CreatePublisherSessionInput {
	publisherDid: string;
	tokenHash: string;
	csrfHash: string;
	expiresAt: number;
	now?: number;
}

export interface StoredPublisherSession {
	publisherDid: string;
	expiresAt: number;
	sessionEpoch: number;
}

export type CreatePublisherSessionResult =
	| { ok: true; session: StoredPublisherSession }
	| {
			ok: false;
			code: "PUBLISHER_SESSION_EXISTS" | "PUBLISHER_SESSION_LIMIT_REACHED" | "PUBLISHER_SUSPENDED";
	  };

export type ValidatePublisherSessionResult =
	| { ok: true; session: StoredPublisherSession }
	| {
			ok: false;
			code: "PUBLISHER_SESSION_INVALID" | "PUBLISHER_SESSION_EXPIRED" | "PUBLISHER_SUSPENDED";
	  };

export type RequestWorkflowConnectionResult =
	| { ok: true; status: "connected"; policy: StoredWorkloadPolicy }
	| {
			ok: true;
			status: "pending";
			request: StoredWorkflowConnectionRequest;
			replayed: boolean;
	  }
	| {
			ok: false;
			code:
				| "DELEGATION_REQUIRED"
				| "PUBLISHER_SUSPENDED"
				| "WORKFLOW_CONNECTION_CONFLICT"
				| "WORKFLOW_CONNECTION_INVITATION_EXPIRED"
				| "WORKFLOW_CONNECTION_INVITATION_INVALID"
				| "WORKFLOW_CONNECTION_INVITATION_REQUIRED"
				| "WORKFLOW_CONNECTION_LIMIT_REACHED";
	  };

export type CreateWorkflowConnectionInvitationResult =
	| StoreWorkflowConnectionInvitationResult
	| { ok: false; code: "DELEGATION_REQUIRED" | "PUBLISHER_SUSPENDED" };

export type RejectWorkflowConnectionRequestResult =
	| StoreRejectWorkflowConnectionRequestResult
	| { ok: false; code: "PUBLISHER_SUSPENDED" };

export type ConfirmWorkflowConnectionResult =
	| {
			ok: true;
			request: StoredWorkflowConnectionRequest;
			policy: StoredWorkloadPolicy;
			replayed: boolean;
	  }
	| {
			ok: false;
			code:
				| "DELEGATION_REQUIRED"
				| "WORKFLOW_CONNECTION_CONFLICT"
				| "WORKFLOW_CONNECTION_EXPIRED"
				| "WORKFLOW_CONNECTION_NOT_FOUND";
	  };

interface OAuthStateRow {
	[key: string]: string | number | ArrayBuffer | null;
	encrypted_state: string;
	encryption_key_version: number;
	client_key_id: string;
	redirect_target: string;
	expires_at: number;
}

interface DelegationRow {
	[key: string]: string | number | ArrayBuffer | null;
	release_nsid: string;
	scope: string;
	client_key_id: string;
	encrypted_session: string;
	encryption_key_version: number | null;
	issuer: string | null;
	pds_url: string | null;
	expires_at: number | null;
	refresh_before: number | null;
	status: StoredDelegation["status"];
	state_version: number;
}

interface OperationRow {
	[key: string]: string | number | ArrayBuffer | null;
	generation: number;
	token_hash: string | null;
	delegation_version: number | null;
	expires_at: number | null;
}

interface EncryptionRecordRow {
	[key: string]: string | number | ArrayBuffer | null;
	cursor: string;
	envelope: string;
	key_version: number;
	purpose: "oauth-session" | PublisherOAuthEncryptionPurpose;
}

interface AuditRow {
	[key: string]: string | number | ArrayBuffer | null;
	sequence: number;
	event_type: string;
	actor_realm: PublisherAuditEvent["actorRealm"];
	actor_identity: string;
	subject: string;
	reason_code: string | null;
	public_payload: string;
	created_at: number;
}

function validBoundedString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function validRelativeRedirectPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 2048 &&
		value.startsWith("/") &&
		!value.startsWith("//")
	);
}

function validPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 1;
}

function validPublisherOAuthEncryptionPurpose(
	value: unknown,
): value is PublisherOAuthEncryptionPurpose {
	return value === "oauth-console-transaction" || value === "oauth-delegation-transaction";
}

function validOptionalTimestamp(value: unknown): value is number | null {
	return value === null || Number.isSafeInteger(value);
}

function validHttpsOrigin(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.username === "" &&
			url.password === "" &&
			url.search === "" &&
			url.hash === "" &&
			url.pathname === "/" &&
			(value === url.origin || value === `${url.origin}/`)
		);
	} catch {
		return false;
	}
}

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(BASE64_PADDING_PATTERN, "");
}

async function hashRefreshToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return encodeBase64Url(new Uint8Array(digest));
}

async function expirationDigest(intentId: string, expiresAt: number): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(["intent-expired", intentId, expiresAt])),
	);
	return encodeBase64Url(new Uint8Array(digest));
}

function workloadPolicyEquals(
	policy: StoredWorkloadPolicy,
	expected: Pick<
		StoredWorkloadPolicy,
		| "active"
		| "allowedEnvironments"
		| "allowedRefs"
		| "packageSlug"
		| "repository"
		| "repositoryId"
		| "repositoryOwnerId"
		| "workflowRef"
	>,
): boolean {
	return (
		policy.packageSlug === expected.packageSlug &&
		policy.repository === expected.repository &&
		policy.repositoryId === expected.repositoryId &&
		policy.repositoryOwnerId === expected.repositoryOwnerId &&
		policy.workflowRef === expected.workflowRef &&
		JSON.stringify(policy.allowedRefs) === JSON.stringify(expected.allowedRefs) &&
		JSON.stringify(policy.allowedEnvironments) === JSON.stringify(expected.allowedEnvironments) &&
		policy.active === expected.active
	);
}

export class PublisherDurableObject extends DurableObject<Env> {
	readonly #objectName: string | undefined;
	readonly #workloadPolicies: WorkloadPolicyStore;
	readonly #intents: IntentStateStore;
	readonly #publicationCoordinations: PublicationCoordinationStore;
	readonly #publicationMaterializations: PublicationMaterializationStore;
	readonly #publicationOperations: PublicationOperationStore;
	readonly #verificationSteps: VerificationStepStore;
	readonly #operationsRestore: OperationsRestoreStore;
	readonly #intentRateLimits: IntentRateLimitStore;
	readonly #workflowConnections: WorkflowConnectionStore;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#objectName = ctx.id.name;
		this.#workloadPolicies = new WorkloadPolicyStore(ctx.storage);
		this.#intents = new IntentStateStore(ctx.storage);
		this.#publicationCoordinations = new PublicationCoordinationStore(ctx.storage);
		this.#publicationMaterializations = new PublicationMaterializationStore(ctx.storage);
		this.#publicationOperations = new PublicationOperationStore(ctx.storage);
		this.#verificationSteps = new VerificationStepStore(ctx.storage);
		this.#operationsRestore = new OperationsRestoreStore(ctx.storage);
		this.#intentRateLimits = new IntentRateLimitStore(ctx.storage);
		this.#workflowConnections = new WorkflowConnectionStore(ctx.storage);
		void ctx.blockConcurrencyWhile(() => {
			this.#initializeSchema();
			return Promise.resolve();
		});
	}

	#initializeSchema(): void {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS publisher (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				did TEXT NOT NULL UNIQUE,
				status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
				session_epoch INTEGER NOT NULL DEFAULT 1 CHECK (session_epoch >= 1),
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS oauth_states (
				state_hash TEXT PRIMARY KEY,
				encrypted_state TEXT NOT NULL,
				encryption_key_version INTEGER NOT NULL CHECK (encryption_key_version >= 1),
				encryption_purpose TEXT NOT NULL CHECK (
					encryption_purpose IN ('oauth-console-transaction', 'oauth-delegation-transaction')
				),
				client_key_id TEXT NOT NULL,
				redirect_target TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry ON oauth_states(expires_at);
			CREATE TABLE IF NOT EXISTS delegation (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				release_nsid TEXT NOT NULL,
				scope TEXT NOT NULL,
				client_key_id TEXT NOT NULL,
				encrypted_session TEXT NOT NULL,
				encryption_key_version INTEGER,
				issuer TEXT,
				pds_url TEXT,
				expires_at INTEGER,
				refresh_before INTEGER,
				status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'reauthorization_required')),
				state_version INTEGER NOT NULL CHECK (state_version >= 1),
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS delegation_operations (
				kind TEXT PRIMARY KEY CHECK (kind = 'refresh'),
				generation INTEGER NOT NULL CHECK (generation >= 0),
				token_hash TEXT,
				delegation_version INTEGER,
				expires_at INTEGER,
				updated_at INTEGER NOT NULL,
				CHECK (
					(token_hash IS NULL AND delegation_version IS NULL AND expires_at IS NULL)
					OR (token_hash IS NOT NULL AND delegation_version IS NOT NULL AND expires_at IS NOT NULL)
				)
			);
			INSERT OR IGNORE INTO delegation_operations (
				kind, generation, token_hash, delegation_version, expires_at, updated_at
			) VALUES ('refresh', 0, NULL, NULL, NULL, 0);
			CREATE TABLE IF NOT EXISTS publisher_sessions (
				token_hash TEXT PRIMARY KEY,
				csrf_hash TEXT NOT NULL,
				session_epoch INTEGER NOT NULL CHECK (session_epoch >= 1),
				expires_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				last_seen_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_publisher_sessions_expiry
				ON publisher_sessions(expires_at);
			CREATE TABLE IF NOT EXISTS audit_events (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				event_type TEXT NOT NULL,
				actor_realm TEXT NOT NULL CHECK (actor_realm IN ('oidc', 'publisher', 'approver', 'access', 'system')),
				actor_identity TEXT NOT NULL,
				subject TEXT NOT NULL,
				reason_code TEXT,
				public_payload TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
		`);
		initializeWorkloadPolicySchema(this.ctx.storage);
		initializeIntentStateSchema(this.ctx.storage);
		initializePublicationCoordinationSchema(this.ctx.storage);
		initializePublicationMaterializationSchema(this.ctx.storage);
		initializePublicationOperationSchema(this.ctx.storage);
		initializeVerificationStepSchema(this.ctx.storage);
		initializeOperationsRestoreSchema(this.ctx.storage);
		initializeIntentRateLimitSchema(this.ctx.storage);
		initializeWorkflowConnectionSchema(this.ctx.storage);
	}

	#assertPublisherObjectName(publisherDid: string): void {
		if (!DID_PATTERN.test(publisherDid)) {
			throw new PublisherStateError("PUBLISHER_DID_INVALID");
		}
		if (this.#objectName === undefined || this.#objectName !== publisherDid) {
			throw new PublisherStateError("PUBLISHER_DID_MISMATCH");
		}
	}

	#assertPublisherDid(publisherDid: string): void {
		this.#assertPublisherObjectName(publisherDid);
		const existing = this.ctx.storage.sql
			.exec<PublisherRow>("SELECT did FROM publisher WHERE id = 1")
			.toArray()[0];
		if (existing && existing.did !== publisherDid) {
			throw new PublisherStateError("PUBLISHER_DID_MISMATCH");
		}
		if (!existing) {
			this.ctx.storage.sql.exec(
				"INSERT INTO publisher (id, did, created_at) VALUES (1, ?, ?)",
				publisherDid,
				Date.now(),
			);
		}
	}

	#appendAudit(
		eventType: string,
		actorRealm: "access" | "publisher" | "system",
		actorIdentity: string,
		subject: string,
		createdAt: number,
		reasonCode: string | null = null,
	): void {
		this.ctx.storage.sql.exec(
			`INSERT INTO audit_events (
				event_type, actor_realm, actor_identity, subject, reason_code, public_payload, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			eventType,
			actorRealm,
			actorIdentity,
			subject,
			reasonCode,
			"{}",
			createdAt,
		);
	}

	initializePublisher(publisherDid: string): void {
		this.#assertPublisherDid(publisherDid);
	}

	setPublisherSuspended(
		publisherDid: string,
		suspended: boolean,
		actorIdentity: string,
		now = Date.now(),
	): { status: "active" | "suspended"; changed: boolean } {
		this.#assertPublisherDid(publisherDid);
		if (
			typeof suspended !== "boolean" ||
			!ACTOR_IDENTITY_PATTERN.test(actorIdentity) ||
			!Number.isSafeInteger(now) ||
			now < 0
		) {
			throw new PublisherStateError("PUBLISHER_SESSION_INVALID");
		}
		return this.ctx.storage.transactionSync(() => {
			const row = this.ctx.storage.sql
				.exec<{ status: "active" | "suspended"; session_epoch: number }>(
					"SELECT status, session_epoch FROM publisher WHERE id = 1",
				)
				.one();
			const status = suspended ? "suspended" : "active";
			if (row.status === status) return { status, changed: false };
			this.ctx.storage.sql.exec(
				"UPDATE publisher SET status = ?, session_epoch = ? WHERE id = 1",
				status,
				suspended ? row.session_epoch + 1 : row.session_epoch,
			);
			if (suspended) this.ctx.storage.sql.exec("DELETE FROM publisher_sessions");
			this.#appendAudit(
				"publisher-suspension-changed",
				"access",
				actorIdentity,
				publisherDid,
				now,
				suspended ? "PUBLISHER_SUSPENDED" : null,
			);
			return { status, changed: true };
		});
	}

	async putWorkloadPolicy(input: PutWorkloadPolicyInput): Promise<PutWorkloadPolicyResult> {
		this.#assertPublisherDid(input.publisherDid);
		const result = this.#workloadPolicies.put(input);
		if (!result.ok) return result;
		const invalidations = await Promise.allSettled(
			result.invalidatedApprovalChallenges.map((invalidation) =>
				invalidateApprovalChallenges(
					this.env.APPROVER_DO,
					invalidation.approverDids,
					invalidation.intentId,
					"WORKLOAD_CHANGED",
					input.now ?? Date.now(),
				),
			),
		);
		for (const invalidation of invalidations) {
			if (invalidation.status === "rejected") {
				console.error(
					JSON.stringify({
						event: "workload_approval_invalidation_failed",
						publisherDid: input.publisherDid,
						name: invalidation.reason instanceof Error ? invalidation.reason.name : "UnknownError",
					}),
				);
			}
		}
		return { ok: true, policy: result.policy };
	}

	getWorkloadPolicy(publisherDid: string, packageSlug: string): StoredWorkloadPolicy | null {
		this.#assertPublisherDid(publisherDid);
		return this.#workloadPolicies.get(packageSlug);
	}

	getWorkloadPolicyIfInitialized(
		publisherDid: string,
		packageSlug: string,
	): StoredWorkloadPolicy | null {
		this.#assertPublisherObjectName(publisherDid);
		const owner = this.ctx.storage.sql
			.exec<PublisherRow>("SELECT did FROM publisher WHERE id = 1")
			.toArray()[0];
		if (!owner) return null;
		if (owner.did !== publisherDid) {
			throw new PublisherStateError("PUBLISHER_DID_MISMATCH");
		}
		return this.#workloadPolicies.get(packageSlug);
	}

	listWorkloadPolicies(
		publisherDid: string,
		afterPackageSlug: string | null,
		limit: number,
	): readonly StoredWorkloadPolicy[] {
		this.#assertPublisherDid(publisherDid);
		return this.#workloadPolicies.list(afterPackageSlug, limit);
	}

	async requestWorkflowConnection(
		input: CreateWorkflowConnectionRequestInput,
	): Promise<RequestWorkflowConnectionResult> {
		this.#assertPublisherObjectName(input.publisherDid);
		const owner = this.ctx.storage.sql
			.exec<PublisherSessionOwnerRow>(
				"SELECT did, status, session_epoch FROM publisher WHERE id = 1",
			)
			.toArray()[0];
		if (!owner || this.#readDelegation()?.status !== "active") {
			return { ok: false, code: "DELEGATION_REQUIRED" };
		}
		if (owner.did !== input.publisherDid) {
			throw new PublisherStateError("PUBLISHER_DID_MISMATCH");
		}
		if (owner.status === "suspended") return { ok: false, code: "PUBLISHER_SUSPENDED" };
		const currentPolicy = this.#workloadPolicies.get(input.packageSlug);
		if (currentPolicy && workflowConnectionPolicyMatches(currentPolicy, input.claim)) {
			return { ok: true, status: "connected", policy: currentPolicy };
		}
		const result = this.#workflowConnections.create(input, currentPolicy?.stateVersion ?? null);
		if (result.ok) await this.#scheduleNextAlarm(input.now ?? Date.now());
		return result.ok
			? { ok: true, status: "pending", request: result.request, replayed: result.replayed }
			: result;
	}

	async createWorkflowConnectionInvitation(
		input: CreateWorkflowConnectionInvitationInput,
	): Promise<CreateWorkflowConnectionInvitationResult> {
		this.#assertPublisherObjectName(input.publisherDid);
		const owner = this.ctx.storage.sql
			.exec<PublisherSessionOwnerRow>(
				"SELECT did, status, session_epoch FROM publisher WHERE id = 1",
			)
			.toArray()[0];
		if (!owner || this.#readDelegation()?.status !== "active") {
			return { ok: false, code: "DELEGATION_REQUIRED" };
		}
		if (owner.did !== input.publisherDid) {
			throw new PublisherStateError("PUBLISHER_DID_MISMATCH");
		}
		if (owner.status === "suspended") return { ok: false, code: "PUBLISHER_SUSPENDED" };
		const result = this.#workflowConnections.createInvitation(input);
		if (result.ok) {
			this.#appendAudit(
				"workflow-connection-invitation-created",
				"publisher",
				input.publisherDid,
				input.packageSlug,
				input.now ?? Date.now(),
			);
			await this.#scheduleNextAlarm(input.now ?? Date.now());
		}
		return result;
	}

	listWorkflowConnectionRequests(
		publisherDid: string,
		limit: number,
		now = Date.now(),
	): readonly StoredWorkflowConnectionRequest[] {
		this.#assertPublisherDid(publisherDid);
		return this.#workflowConnections.listPending(limit, now);
	}

	async rejectWorkflowConnection(
		publisherDid: string,
		requestId: string,
		now = Date.now(),
	): Promise<RejectWorkflowConnectionRequestResult> {
		this.#assertPublisherDid(publisherDid);
		const owner = this.#readPublisherSessionOwner();
		if (owner?.status === "suspended") return { ok: false, code: "PUBLISHER_SUSPENDED" };
		const result = this.#workflowConnections.reject(requestId, now);
		if (result.ok) {
			this.#appendAudit("workflow-connection-rejected", "publisher", publisherDid, requestId, now);
			await this.#scheduleNextAlarm(now);
		}
		return result;
	}

	async confirmWorkflowConnection(
		publisherDid: string,
		requestId: string,
		refScope: WorkflowConnectionRefScope,
		now = Date.now(),
	): Promise<ConfirmWorkflowConnectionResult> {
		this.#assertPublisherDid(publisherDid);
		const prepared = this.#workflowConnections.prepareConfirmation(requestId, now);
		if (!prepared.ok) return prepared;
		if (this.#readDelegation()?.status !== "active") {
			return { ok: false, code: "DELEGATION_REQUIRED" };
		}
		if (prepared.replayed && prepared.request.refScope !== refScope) {
			return { ok: false, code: "WORKFLOW_CONNECTION_CONFLICT" };
		}
		const expectedVersion = prepared.request.expectedPolicyVersion;
		const expectedPolicy = workflowConnectionPolicy(prepared.request, refScope);
		if (prepared.replayed) {
			const policy = this.#workloadPolicies.get(expectedPolicy.packageSlug);
			return policy && workloadPolicyEquals(policy, expectedPolicy)
				? { ok: true, request: prepared.request, policy, replayed: true }
				: { ok: false, code: "WORKFLOW_CONNECTION_CONFLICT" };
		}
		const result = await this.putWorkloadPolicy({
			publisherDid,
			...expectedPolicy,
			expectedVersion,
			now,
		});
		let policy: StoredWorkloadPolicy | null = result.ok ? result.policy : null;
		if (!policy) {
			const current = this.#workloadPolicies.get(expectedPolicy.packageSlug);
			if (
				current &&
				current.stateVersion === (expectedVersion ?? 0) + 1 &&
				workloadPolicyEquals(current, expectedPolicy)
			) {
				policy = current;
			}
		}
		if (!policy) return { ok: false, code: "WORKFLOW_CONNECTION_CONFLICT" };
		return {
			ok: true,
			request: this.#workflowConnections.complete(requestId, refScope, now),
			policy,
			replayed: false,
		};
	}

	async createIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
		this.#assertPublisherDid(input.publisherDid);
		const result = this.#intents.create(input);
		if (result.ok) await this.#scheduleNextAlarm(input.now ?? Date.now());
		return result;
	}

	async consumeIntentRateLimit(
		input: ConsumeIntentRateLimitInput,
	): Promise<ConsumeIntentRateLimitResult> {
		this.#assertPublisherDid(input.publisherDid);
		const result = this.#intentRateLimits.consume(input);
		if (result.ok) await this.#scheduleNextAlarm(input.now ?? Date.now());
		return result;
	}

	findIdempotentIntent(
		publisherDid: string,
		workloadIdempotencyDigest: string,
		idempotencyKey: string,
		now = Date.now(),
	): IntentIdempotencyMatch | null {
		this.#assertPublisherDid(publisherDid);
		return this.#intents.findIdempotent(workloadIdempotencyDigest, idempotencyKey, now);
	}

	transitionIntent(input: TransitionIntentInput): TransitionIntentResult {
		this.#assertPublisherDid(input.publisherDid);
		return this.#intents.transition(input);
	}

	getIntent(publisherDid: string, intentId: string): StoredIntent | null {
		this.#assertPublisherDid(publisherDid);
		return this.#intents.get(intentId);
	}

	listIntents(
		publisherDid: string,
		afterIntentId: string | null,
		limit: number,
	): readonly StoredIntent[] {
		this.#assertPublisherDid(publisherDid);
		return this.#intents.list(afterIntentId, limit);
	}

	listIntentTransitions(publisherDid: string, intentId: string): readonly IntentTransition[] {
		this.#assertPublisherDid(publisherDid);
		return this.#intents.listTransitions(intentId);
	}

	putVerificationStep(input: PutVerificationStepInput): PutVerificationStepResult {
		this.#assertPublisherDid(input.publisherDid);
		return this.#verificationSteps.put(input);
	}

	getVerificationStep(
		publisherDid: string,
		intentId: string,
		name: VerificationStepName,
	): StoredVerificationStep | null {
		this.#assertPublisherDid(publisherDid);
		return this.#verificationSteps.get(intentId, name);
	}

	listVerificationSteps(publisherDid: string, intentId: string): readonly StoredVerificationStep[] {
		this.#assertPublisherDid(publisherDid);
		return this.#verificationSteps.list(intentId);
	}

	async beginPublicationOperation(
		publisherDid: string,
		intentId: string,
		expectedIntentGeneration: number,
		leaseMs: number,
		attemptKey: string,
		token: string,
		now = Date.now(),
	): Promise<BeginPublicationOperationResult> {
		this.#assertPublisherDid(publisherDid);
		const result = await this.#publicationOperations.begin(
			publisherDid,
			intentId,
			expectedIntentGeneration,
			leaseMs,
			attemptKey,
			token,
			now,
		);
		await this.#scheduleNextAlarm(now);
		return result;
	}

	async acquirePublicationCoordination(
		publisherDid: string,
		packageSlug: string,
		intentId: string,
		leaseMs: number,
		token: string,
		now = Date.now(),
	): Promise<AcquirePublicationCoordinationResult> {
		this.#assertPublisherDid(publisherDid);
		const result = await this.#publicationCoordinations.acquire(
			publisherDid,
			packageSlug,
			intentId,
			leaseMs,
			token,
			now,
		);
		await this.#scheduleNextAlarm(now);
		return result;
	}

	async renewPublicationCoordination(
		input: RenewPublicationCoordinationInput,
	): Promise<RenewPublicationCoordinationResult> {
		this.#assertPublisherDid(input.publisherDid);
		const result = await this.#publicationCoordinations.renew(input);
		await this.#scheduleNextAlarm(input.now ?? Date.now());
		return result;
	}

	async releasePublicationCoordination(
		input: ReleasePublicationCoordinationInput,
	): Promise<ReleasePublicationCoordinationResult> {
		this.#assertPublisherDid(input.publisherDid);
		const result = await this.#publicationCoordinations.release(input);
		await this.#scheduleNextAlarm(input.now ?? Date.now());
		return result;
	}

	async completePublicationOperation(
		input: CompletePublicationOperationInput,
	): Promise<CompletePublicationOperationResult> {
		this.#assertPublisherDid(input.publisherDid);
		const result = await this.#publicationOperations.complete(input);
		await this.#scheduleNextAlarm(input.now ?? Date.now());
		return result;
	}

	async advancePublicationOperationPhase(
		input: AdvancePublicationOperationPhaseInput,
	): Promise<AdvancePublicationOperationPhaseResult> {
		this.#assertPublisherDid(input.publisherDid);
		const intent = input.phase === "creating" ? this.#intents.get(input.intentId) : null;
		const identity = intent
			? await parseStoredWorkloadIdentity(
					intent.workloadIdentityJson,
					intent.workloadIdentityDigest,
				)
			: null;
		const authorization =
			intent && identity
				? {
						identity,
						identityDigest: intent.workloadIdentityDigest,
						identityJson: intent.workloadIdentityJson,
					}
				: null;
		const result = await this.#publicationOperations.advancePhase(input, authorization);
		await this.#scheduleNextAlarm(input.now ?? Date.now());
		return result;
	}

	beginPublicationMaterialization(
		publisherDid: string,
		intentId: string,
		sourceDigest: string,
		now?: number,
	): PublicationMaterializationMutationResult {
		this.#assertPublisherDid(publisherDid);
		return this.#publicationMaterializations.begin(publisherDid, intentId, sourceDigest, now);
	}

	putPublicationArtifactStage(
		input: PutPublicationArtifactStageInput,
	): PublicationMaterializationMutationResult {
		this.#assertPublisherDid(input.publisherDid);
		return this.#publicationMaterializations.putStage(input);
	}

	putPublicationBlobReceipt(
		input: PutPublicationBlobReceiptInput,
	): PublicationMaterializationMutationResult {
		this.#assertPublisherDid(input.publisherDid);
		return this.#publicationMaterializations.putReceipt(input);
	}

	completePublicationMaterialization(
		input: CompletePublicationMaterializationInput,
	): Promise<PublicationMaterializationMutationResult> {
		this.#assertPublisherDid(input.publisherDid);
		return this.#publicationMaterializations.complete(input);
	}

	getPublicationMaterialization(
		publisherDid: string,
		intentId: string,
	): StoredPublicationMaterialization | null {
		this.#assertPublisherDid(publisherDid);
		return this.#publicationMaterializations.get(intentId);
	}

	async createPublisherSession(
		input: CreatePublisherSessionInput,
	): Promise<CreatePublisherSessionResult> {
		this.#assertPublisherDid(input.publisherDid);
		const now = input.now ?? Date.now();
		if (
			!TOKEN_PATTERN.test(input.tokenHash) ||
			!TOKEN_PATTERN.test(input.csrfHash) ||
			!Number.isSafeInteger(now) ||
			!Number.isSafeInteger(input.expiresAt) ||
			input.expiresAt <= now ||
			input.expiresAt - now > MAX_PUBLISHER_SESSION_MS
		) {
			throw new PublisherStateError("PUBLISHER_SESSION_INVALID");
		}
		const result = this.ctx.storage.transactionSync(() => {
			const owner = this.#readPublisherSessionOwner();
			if (!owner || owner.status === "suspended") {
				return { ok: false, code: "PUBLISHER_SUSPENDED" } as const;
			}
			const existing = this.ctx.storage.sql
				.exec<{ token_hash: string }>(
					"SELECT token_hash FROM publisher_sessions WHERE token_hash = ?",
					input.tokenHash,
				)
				.toArray()[0];
			if (existing) return { ok: false, code: "PUBLISHER_SESSION_EXISTS" } as const;
			this.ctx.storage.sql.exec("DELETE FROM publisher_sessions WHERE expires_at <= ?", now);
			const count = this.ctx.storage.sql
				.exec<{ count: number }>("SELECT COUNT(*) AS count FROM publisher_sessions")
				.one().count;
			if (count >= MAX_ACTIVE_PUBLISHER_SESSIONS) {
				return { ok: false, code: "PUBLISHER_SESSION_LIMIT_REACHED" } as const;
			}
			this.ctx.storage.sql.exec(
				`INSERT INTO publisher_sessions (
					token_hash, csrf_hash, session_epoch, expires_at, created_at, last_seen_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				input.tokenHash,
				input.csrfHash,
				owner.session_epoch,
				input.expiresAt,
				now,
				now,
			);
			this.#appendAudit(
				"publisher-session-created",
				"publisher",
				input.publisherDid,
				input.tokenHash,
				now,
			);
			return {
				ok: true,
				session: {
					publisherDid: input.publisherDid,
					expiresAt: input.expiresAt,
					sessionEpoch: owner.session_epoch,
				},
			} as const;
		});
		if (result.ok) await this.#scheduleNextAlarm(now);
		return result;
	}

	validatePublisherSession(
		publisherDid: string,
		tokenHash: string,
		csrfHash: string | null,
		now = Date.now(),
	): ValidatePublisherSessionResult {
		this.#assertPublisherObjectName(publisherDid);
		if (
			!TOKEN_PATTERN.test(tokenHash) ||
			(csrfHash !== null && !TOKEN_PATTERN.test(csrfHash)) ||
			!Number.isSafeInteger(now)
		) {
			return { ok: false, code: "PUBLISHER_SESSION_INVALID" };
		}
		return this.ctx.storage.transactionSync(() => {
			const owner = this.#readPublisherSessionOwner();
			if (!owner) return { ok: false, code: "PUBLISHER_SESSION_INVALID" } as const;
			if (owner.status === "suspended") {
				return { ok: false, code: "PUBLISHER_SUSPENDED" } as const;
			}
			const session = this.ctx.storage.sql
				.exec<PublisherSessionRow>(
					`SELECT token_hash, csrf_hash, session_epoch, expires_at
					 FROM publisher_sessions WHERE token_hash = ?`,
					tokenHash,
				)
				.toArray()[0];
			if (!session || session.session_epoch !== owner.session_epoch) {
				return { ok: false, code: "PUBLISHER_SESSION_INVALID" } as const;
			}
			if (session.expires_at <= now) {
				this.ctx.storage.sql.exec("DELETE FROM publisher_sessions WHERE token_hash = ?", tokenHash);
				return { ok: false, code: "PUBLISHER_SESSION_EXPIRED" } as const;
			}
			if (csrfHash !== null && session.csrf_hash !== csrfHash) {
				return { ok: false, code: "PUBLISHER_SESSION_INVALID" } as const;
			}
			this.ctx.storage.sql.exec(
				"UPDATE publisher_sessions SET last_seen_at = ? WHERE token_hash = ?",
				now,
				tokenHash,
			);
			return {
				ok: true,
				session: {
					publisherDid: owner.did,
					expiresAt: session.expires_at,
					sessionEpoch: session.session_epoch,
				},
			} as const;
		});
	}

	revokePublisherSession(publisherDid: string, tokenHash: string): boolean {
		this.#assertPublisherObjectName(publisherDid);
		if (!TOKEN_PATTERN.test(tokenHash)) return false;
		return this.ctx.storage.transactionSync(() => {
			const deleted = this.ctx.storage.sql
				.exec("DELETE FROM publisher_sessions WHERE token_hash = ? RETURNING token_hash", tokenHash)
				.toArray();
			if (deleted.length === 0) return false;
			this.#appendAudit(
				"publisher-session-revoked",
				"publisher",
				publisherDid,
				tokenHash,
				Date.now(),
			);
			return true;
		});
	}

	revokeAllPublisherSessions(publisherDid: string, actorIdentity?: string): number | null {
		this.#assertPublisherObjectName(publisherDid);
		if (actorIdentity !== undefined && !ACTOR_IDENTITY_PATTERN.test(actorIdentity)) {
			throw new PublisherStateError("PUBLISHER_SESSION_INVALID");
		}
		return this.ctx.storage.transactionSync(() => {
			const owner = this.#readPublisherSessionOwner();
			if (!owner) return null;
			const nextEpoch = owner.session_epoch + 1;
			const now = Date.now();
			this.ctx.storage.sql.exec("UPDATE publisher SET session_epoch = ? WHERE id = 1", nextEpoch);
			this.ctx.storage.sql.exec("DELETE FROM publisher_sessions");
			this.#appendAudit(
				"publisher-sessions-revoked",
				actorIdentity ? "access" : "publisher",
				actorIdentity ?? publisherDid,
				publisherDid,
				now,
			);
			return nextEpoch;
		});
	}

	async putOAuthState(input: PutOAuthStateInput): Promise<PutOAuthStateResult> {
		this.#assertPublisherDid(input.publisherDid);
		const now = input.now ?? Date.now();
		if (
			!HASH_PATTERN.test(input.stateHash) ||
			!validBoundedString(input.encryptedState, MAX_CIPHERTEXT_CHARS) ||
			!validPositiveInteger(input.encryptionKeyVersion) ||
			!validPublisherOAuthEncryptionPurpose(input.encryptionPurpose) ||
			!validBoundedString(input.clientKeyId, 128) ||
			!validRelativeRedirectPath(input.redirectTarget) ||
			!Number.isSafeInteger(input.expiresAt) ||
			input.expiresAt <= now ||
			!Number.isSafeInteger(now) ||
			now < 0
		) {
			throw new PublisherStateError("OAUTH_STATE_INVALID");
		}
		const result = this.ctx.storage.transactionSync(() => {
			const existing = this.ctx.storage.sql
				.exec<{ state_hash: string }>(
					"SELECT state_hash FROM oauth_states WHERE state_hash = ?",
					input.stateHash,
				)
				.toArray()[0];
			if (existing) return { ok: false, code: "OAUTH_STATE_EXISTS" } as const;
			this.ctx.storage.sql.exec("DELETE FROM oauth_states WHERE expires_at <= ?", now);
			const count = this.ctx.storage.sql
				.exec<{ count: number }>("SELECT COUNT(*) AS count FROM oauth_states")
				.one().count;
			if (count >= MAX_ACTIVE_OAUTH_STATES) {
				return { ok: false, code: "OAUTH_STATE_LIMIT_REACHED" } as const;
			}
			this.ctx.storage.sql.exec(
				`INSERT INTO oauth_states (
						state_hash, encrypted_state, encryption_key_version, encryption_purpose, client_key_id,
						redirect_target, expires_at, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				input.stateHash,
				input.encryptedState,
				input.encryptionKeyVersion,
				input.encryptionPurpose,
				input.clientKeyId,
				input.redirectTarget,
				input.expiresAt,
				now,
			);
			this.#appendAudit(
				"oauth-state-created",
				"publisher",
				input.publisherDid,
				input.stateHash,
				now,
			);
			return { ok: true } as const;
		});
		if (result.ok) await this.#scheduleNextAlarm(now);
		return result;
	}

	async consumeOAuthState(
		publisherDid: string,
		stateHash: string,
		now = Date.now(),
	): Promise<StoredOAuthState | null> {
		this.#assertPublisherDid(publisherDid);
		if (!HASH_PATTERN.test(stateHash) || !Number.isSafeInteger(now)) {
			throw new PublisherStateError("OAUTH_STATE_INVALID");
		}
		const result = this.ctx.storage.transactionSync(() => {
			const row = this.ctx.storage.sql
				.exec<OAuthStateRow>(
					`SELECT encrypted_state, encryption_key_version, client_key_id, redirect_target, expires_at
					 FROM oauth_states WHERE state_hash = ?`,
					stateHash,
				)
				.toArray()[0];
			if (!row) return null;
			this.ctx.storage.sql.exec("DELETE FROM oauth_states WHERE state_hash = ?", stateHash);
			if (row.expires_at <= now) {
				this.#appendAudit(
					"oauth-state-expired",
					"system",
					"release-service",
					stateHash,
					now,
					"OAUTH_STATE_EXPIRED",
				);
				return null;
			}
			this.#appendAudit("oauth-state-consumed", "publisher", publisherDid, stateHash, now);
			return {
				encryptedState: row.encrypted_state,
				encryptionKeyVersion: row.encryption_key_version,
				clientKeyId: row.client_key_id,
				redirectTarget: row.redirect_target,
				expiresAt: row.expires_at,
			};
		});
		await this.#scheduleNextAlarm(now);
		return result;
	}

	putDelegation(input: PutDelegationInput): PutDelegationResult {
		this.#assertPublisherDid(input.publisherDid);
		if (
			!validBoundedString(input.releaseNsid, 512) ||
			!validBoundedString(input.scope, 2048) ||
			!validBoundedString(input.clientKeyId, 128) ||
			!validBoundedString(input.encryptedSession, MAX_CIPHERTEXT_CHARS) ||
			!validPositiveInteger(input.encryptionKeyVersion) ||
			!validHttpsOrigin(input.issuer) ||
			!validHttpsOrigin(input.pdsUrl) ||
			!validOptionalTimestamp(input.expiresAt) ||
			!validOptionalTimestamp(input.refreshBefore) ||
			(input.expectedVersion !== null &&
				(!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1))
		) {
			throw new PublisherStateError("DELEGATION_INVALID");
		}
		return this.ctx.storage.transactionSync(() => {
			const now = Date.now();
			const current = this.#readDelegation();
			if (
				(current === null && input.expectedVersion !== null) ||
				(current !== null && input.expectedVersion !== current.stateVersion)
			) {
				return { ok: false, code: "DELEGATION_CAS_REQUIRED" } as const;
			}
			const stateVersion = (current?.stateVersion ?? 0) + 1;
			this.ctx.storage.sql.exec(
				`INSERT INTO delegation (
					id, release_nsid, scope, client_key_id, encrypted_session,
					encryption_key_version, issuer, pds_url, expires_at, refresh_before,
					status, state_version, updated_at
				) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					release_nsid = excluded.release_nsid,
					scope = excluded.scope,
					client_key_id = excluded.client_key_id,
					encrypted_session = excluded.encrypted_session,
					encryption_key_version = excluded.encryption_key_version,
					issuer = excluded.issuer,
					pds_url = excluded.pds_url,
					expires_at = excluded.expires_at,
					refresh_before = excluded.refresh_before,
					status = 'active',
					state_version = excluded.state_version,
					updated_at = excluded.updated_at`,
				input.releaseNsid,
				input.scope,
				input.clientKeyId,
				input.encryptedSession,
				input.encryptionKeyVersion,
				input.issuer,
				input.pdsUrl,
				input.expiresAt,
				input.refreshBefore,
				stateVersion,
				now,
			);
			this.#clearRefreshOperation(now);
			this.#appendAudit(
				"delegation-stored",
				"publisher",
				input.publisherDid,
				input.releaseNsid,
				now,
			);
			return { ok: true, delegation: this.#readDelegation()! } as const;
		});
	}

	getDelegation(publisherDid: string): StoredDelegation | null {
		this.#assertPublisherDid(publisherDid);
		return this.#readDelegation();
	}

	getOperationsMetadata(publisherDid: string): PublisherOperationsMetadata {
		this.#assertPublisherDid(publisherDid);
		const publisher = this.ctx.storage.sql
			.exec<PublisherOperationsMetadataRow>(
				"SELECT did, status, created_at FROM publisher WHERE id = 1",
			)
			.one();
		const delegation = this.#readDelegation();
		return {
			publisher: {
				did: publisher.did,
				status: publisher.status,
				createdAt: publisher.created_at,
			},
			delegation: delegation
				? {
						releaseNsid: delegation.releaseNsid,
						scope: delegation.scope,
						issuer: delegation.issuer,
						pdsUrl: delegation.pdsUrl,
						expiresAt: delegation.expiresAt,
						refreshBefore: delegation.refreshBefore,
						status: delegation.status,
						stateVersion: delegation.stateVersion,
					}
				: null,
		};
	}

	applyOperationsRestorePage(
		input: ApplyPublisherRestorePageInput,
	): ApplyPublisherRestorePageResult {
		this.#assertPublisherDid(input.publisherDid);
		return this.#operationsRestore.apply(input);
	}

	prepareOperationsRestore(
		publisherDid: string,
		archiveId: string,
		totalPages: number,
		actorIdentity: string,
		now = Date.now(),
	): PreparePublisherRestoreResult {
		this.#assertPublisherDid(publisherDid);
		if (
			!ARCHIVE_ID_PATTERN.test(archiveId) ||
			!Number.isSafeInteger(totalPages) ||
			totalPages < 1 ||
			totalPages > MAX_RESTORE_PAGES ||
			!ACTOR_IDENTITY_PATTERN.test(actorIdentity) ||
			!Number.isSafeInteger(now) ||
			now < 0
		) {
			throw new PublisherStateError("OPERATIONS_EXPORT_INVALID");
		}
		return this.ctx.storage.transactionSync(() => {
			const existing = this.ctx.storage.sql
				.exec<{
					archive_id: string;
					total_pages: number;
					status: "aborted" | "complete" | "prepared" | "restoring";
					deleted_intents: number;
					deleted_workloads: number;
				}>(
					`SELECT archive_id, total_pages, status, deleted_intents, deleted_workloads
					 FROM operations_restore WHERE id = 1`,
				)
				.toArray()[0];
			if (
				existing?.archive_id === archiveId &&
				existing.total_pages === totalPages &&
				existing.status !== "aborted"
			) {
				return {
					ok: true,
					deletedIntents: existing.deleted_intents,
					deletedWorkloads: existing.deleted_workloads,
					replayed: true,
				} as const;
			}
			if (existing && existing.status !== "aborted" && existing.status !== "complete") {
				return { ok: false, code: "RESTORE_CONFLICT" } as const;
			}
			const publisher = this.ctx.storage.sql
				.exec<{ status: string }>("SELECT status FROM publisher WHERE id = 1")
				.one();
			if (publisher.status !== "suspended") {
				return { ok: false, code: "PUBLISHER_NOT_SUSPENDED" } as const;
			}
			const deletedIntents = this.ctx.storage.sql
				.exec<{ count: number }>("SELECT COUNT(*) AS count FROM intents")
				.one().count;
			const deletedWorkloads = this.ctx.storage.sql
				.exec<{ count: number }>("SELECT COUNT(*) AS count FROM workload_policies")
				.one().count;
			this.ctx.storage.sql.exec("DELETE FROM intent_verification_steps");
			this.ctx.storage.sql.exec("DELETE FROM intent_transitions");
			this.ctx.storage.sql.exec("DELETE FROM release_reservations");
			this.ctx.storage.sql.exec("DELETE FROM intent_idempotency");
			this.ctx.storage.sql.exec("DELETE FROM publication_operations");
			this.ctx.storage.sql.exec("DELETE FROM publication_coordinations");
			this.ctx.storage.sql.exec("DELETE FROM deadlines");
			this.ctx.storage.sql.exec("DELETE FROM intents");
			this.ctx.storage.sql.exec("DELETE FROM workload_policies");
			this.ctx.storage.sql.exec("DELETE FROM workflow_connection_requests");
			this.ctx.storage.sql.exec("DELETE FROM workflow_connection_invitations");
			this.ctx.storage.sql.exec("DELETE FROM publisher_sessions");
			this.ctx.storage.sql.exec("DELETE FROM oauth_states");
			this.ctx.storage.sql.exec("DELETE FROM delegation");
			this.ctx.storage.sql.exec("DELETE FROM intent_rate_windows");
			this.ctx.storage.sql.exec("DELETE FROM intent_rate_idempotency");
			this.ctx.storage.sql.exec("DELETE FROM operations_restore_pages");
			this.ctx.storage.sql.exec("DELETE FROM operations_restore");
			this.ctx.storage.sql.exec("DELETE FROM audit_events");
			this.ctx.storage.sql.exec(
				`UPDATE delegation_operations SET generation = generation + 1,
				 token_hash = NULL, delegation_version = NULL, expires_at = NULL, updated_at = ?
				 WHERE kind = 'refresh'`,
				now,
			);
			this.ctx.storage.sql.exec(
				"UPDATE publisher SET session_epoch = session_epoch + 1 WHERE id = 1",
			);
			this.ctx.storage.sql.exec(
				`INSERT INTO operations_restore (
					id, archive_id, total_pages, next_page, last_kind, status,
					deleted_intents, deleted_workloads, actor_identity, updated_at
				) VALUES (1, ?, ?, 0, 'metadata', 'prepared', ?, ?, ?, ?)`,
				archiveId,
				totalPages,
				deletedIntents,
				deletedWorkloads,
				actorIdentity,
				now,
			);
			this.#appendAudit(
				"publisher-restore-prepared",
				"access",
				actorIdentity,
				archiveId,
				now,
				"PUBLISHER_SUSPENDED",
			);
			return { ok: true, deletedIntents, deletedWorkloads, replayed: false } as const;
		});
	}

	abortOperationsRestore(
		publisherDid: string,
		archiveId: string,
		actorIdentity: string,
		now = Date.now(),
	): AbortPublisherRestoreResult {
		this.#assertPublisherDid(publisherDid);
		if (
			!ARCHIVE_ID_PATTERN.test(archiveId) ||
			!ACTOR_IDENTITY_PATTERN.test(actorIdentity) ||
			!Number.isSafeInteger(now) ||
			now < 0
		) {
			throw new PublisherStateError("OPERATIONS_EXPORT_INVALID");
		}
		return this.ctx.storage.transactionSync(() => {
			const publisher = this.ctx.storage.sql
				.exec<{ status: string }>("SELECT status FROM publisher WHERE id = 1")
				.one();
			if (publisher.status !== "suspended") {
				return { ok: false, code: "PUBLISHER_NOT_SUSPENDED" } as const;
			}
			const existing = this.ctx.storage.sql
				.exec<{
					archive_id: string;
					status: "aborted" | "complete" | "prepared" | "restoring";
				}>("SELECT archive_id, status FROM operations_restore WHERE id = 1")
				.toArray()[0];
			if (existing?.archive_id === archiveId && existing.status === "aborted") {
				return { ok: true, replayed: true } as const;
			}
			if (!existing || existing.archive_id !== archiveId || existing.status === "complete") {
				return { ok: false, code: "RESTORE_CONFLICT" } as const;
			}
			this.ctx.storage.sql.exec(
				`UPDATE operations_restore SET status = 'aborted', actor_identity = ?, updated_at = ?
				 WHERE id = 1 AND archive_id = ?`,
				actorIdentity,
				now,
				archiveId,
			);
			this.#appendAudit(
				"publisher-restore-aborted",
				"access",
				actorIdentity,
				archiveId,
				now,
				"RESTORE_ABORTED",
			);
			return { ok: true, replayed: false } as const;
		});
	}

	listAuditEvents(
		publisherDid: string,
		afterSequence: number,
		limit: number,
	): readonly PublisherAuditEvent[] {
		this.#assertPublisherDid(publisherDid);
		if (
			!Number.isSafeInteger(afterSequence) ||
			afterSequence < 0 ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 101
		) {
			throw new PublisherStateError("OPERATIONS_EXPORT_INVALID");
		}
		return this.ctx.storage.sql
			.exec<AuditRow>(
				`SELECT sequence, event_type, actor_realm, actor_identity,
				        subject, reason_code, public_payload, created_at
				 FROM audit_events WHERE sequence > ? ORDER BY sequence LIMIT ?`,
				afterSequence,
				limit,
			)
			.toArray()
			.map((row) => {
				let payload: unknown;
				try {
					payload = JSON.parse(row.public_payload);
				} catch {
					throw new PublisherStateError("PUBLISHER_STATE_CORRUPT");
				}
				if (
					payload === null ||
					typeof payload !== "object" ||
					Array.isArray(payload) ||
					JSON.stringify(payload) !== row.public_payload
				) {
					throw new PublisherStateError("PUBLISHER_STATE_CORRUPT");
				}
				return {
					sequence: row.sequence,
					eventType: row.event_type,
					actorRealm: row.actor_realm,
					actorIdentity: row.actor_identity,
					subject: row.subject,
					reasonCode: row.reason_code,
					publicPayloadJson: row.public_payload,
					createdAt: row.created_at,
				};
			});
	}

	listEncryptionRecords(
		publisherDid: string,
		afterCursor: string | null,
		limit: number,
		now = Date.now(),
	): EncryptionRecordPage {
		this.#assertPublisherDid(publisherDid);
		if (
			(afterCursor !== null && !ENCRYPTION_CURSOR_PATTERN.test(afterCursor)) ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > MAX_ENCRYPTION_RECORD_PAGE ||
			!Number.isSafeInteger(now) ||
			now < 0
		) {
			throw new PublisherStateError("ENCRYPTION_OPERATION_INVALID");
		}
		const rows = this.ctx.storage.sql
			.exec<EncryptionRecordRow>(
				`SELECT cursor, envelope, key_version, purpose FROM (
					SELECT 'delegation:1' AS cursor, encrypted_session AS envelope,
						encryption_key_version AS key_version, 'oauth-session' AS purpose
					FROM delegation
					WHERE status != 'revoked' AND encrypted_session != ''
						AND encryption_key_version IS NOT NULL
					UNION ALL
					SELECT 'oauth-state:' || state_hash AS cursor, encrypted_state AS envelope,
						encryption_key_version AS key_version, encryption_purpose AS purpose
					FROM oauth_states
					WHERE expires_at > ? AND encrypted_state != ''
				) WHERE cursor > ? ORDER BY cursor LIMIT ?`,
				now,
				afterCursor ?? "",
				limit + 1,
			)
			.toArray();
		const hasMore = rows.length > limit;
		const visible = hasMore ? rows.slice(0, limit) : rows;
		const items = visible.map((row) => {
			if (row.purpose !== "oauth-session" && !validPublisherOAuthEncryptionPurpose(row.purpose)) {
				throw new PublisherStateError("ENCRYPTION_OPERATION_INVALID");
			}
			return {
				cursor: row.cursor,
				envelope: row.envelope,
				keyVersion: row.key_version,
				context:
					row.cursor === "delegation:1"
						? {
								purpose: "oauth-session" as const,
								objectClass: "PublisherDurableObject",
								table: "delegation",
								primaryKey: "1",
								ownerDid: publisherDid,
							}
						: {
								purpose: row.purpose,
								objectClass: "PublisherDurableObject",
								table: "oauth_states",
								primaryKey: row.cursor.slice("oauth-state:".length),
								ownerDid: publisherDid,
							},
			};
		});
		return {
			items,
			nextCursor: hasMore ? (items.at(-1)?.cursor ?? null) : null,
		};
	}

	replaceEncryptionRecord(input: EncryptionRecordReplacement & { publisherDid: string }): boolean {
		this.#assertPublisherDid(input.publisherDid);
		const now = input.now ?? Date.now();
		if (
			!ENCRYPTION_CURSOR_PATTERN.test(input.cursor) ||
			!validBoundedString(input.expectedEnvelope, MAX_CIPHERTEXT_CHARS) ||
			!validBoundedString(input.replacementEnvelope, MAX_CIPHERTEXT_CHARS) ||
			!validPositiveInteger(input.replacementKeyVersion) ||
			!ACTOR_IDENTITY_PATTERN.test(input.actorIdentity) ||
			!Number.isSafeInteger(now) ||
			now < 0
		) {
			throw new PublisherStateError("ENCRYPTION_OPERATION_INVALID");
		}
		return this.ctx.storage.transactionSync(() => {
			const result =
				input.cursor === "delegation:1"
					? this.ctx.storage.sql.exec(
							`UPDATE delegation SET encrypted_session = ?, encryption_key_version = ?
							 WHERE id = 1 AND status != 'revoked' AND encrypted_session = ?`,
							input.replacementEnvelope,
							input.replacementKeyVersion,
							input.expectedEnvelope,
						)
					: this.ctx.storage.sql.exec(
							`UPDATE oauth_states SET encrypted_state = ?, encryption_key_version = ?
							 WHERE state_hash = ? AND encrypted_state = ? AND expires_at > ?`,
							input.replacementEnvelope,
							input.replacementKeyVersion,
							input.cursor.slice("oauth-state:".length),
							input.expectedEnvelope,
							now,
						);
			if (result.rowsWritten !== 1) return false;
			this.#appendAudit("encryption-rotated", "access", input.actorIdentity, input.cursor, now);
			return true;
		});
	}

	async beginDelegationRefresh(
		publisherDid: string,
		leaseDurationMs: number,
		now = Date.now(),
	): Promise<BeginDelegationRefreshResult> {
		this.#assertPublisherDid(publisherDid);
		if (
			!Number.isSafeInteger(now) ||
			!Number.isSafeInteger(leaseDurationMs) ||
			leaseDurationMs < 1 ||
			leaseDurationMs > MAX_REFRESH_LEASE_MS
		) {
			throw new PublisherStateError("DELEGATION_INVALID");
		}
		const tokenBytes = crypto.getRandomValues(new Uint8Array(REFRESH_TOKEN_BYTES));
		const token = encodeBase64Url(tokenBytes);
		const tokenHash = await hashRefreshToken(token);
		return this.ctx.storage.transactionSync(() => {
			const current = this.#readDelegation();
			if (!current || current.status !== "active" || current.encryptedSession.length === 0) {
				return { ok: false, code: "DELEGATION_UNAVAILABLE" } as const;
			}
			const operation = this.#readRefreshOperation();
			if (
				operation.token_hash !== null &&
				operation.expires_at !== null &&
				operation.expires_at > now
			) {
				return {
					ok: false,
					code: "DELEGATION_REFRESH_BUSY",
					retryAt: operation.expires_at,
				} as const;
			}
			const generation = operation.generation + 1;
			const expiresAt = now + leaseDurationMs;
			this.ctx.storage.sql.exec(
				`UPDATE delegation_operations SET
					generation = ?, token_hash = ?, delegation_version = ?, expires_at = ?, updated_at = ?
				 WHERE kind = 'refresh'`,
				generation,
				tokenHash,
				current.stateVersion,
				expiresAt,
				now,
			);
			this.#appendAudit(
				"delegation-refresh-started",
				"system",
				"release-service",
				current.releaseNsid,
				now,
			);
			return {
				ok: true,
				lease: {
					generation,
					token,
					expectedVersion: current.stateVersion,
					expiresAt,
				},
			} as const;
		});
	}

	async getDelegationForRefresh(
		publisherDid: string,
		generation: number,
		token: string,
		now = Date.now(),
	): Promise<StoredDelegation | null> {
		this.#assertPublisherDid(publisherDid);
		if (
			!validPositiveInteger(generation) ||
			!TOKEN_PATTERN.test(token) ||
			!Number.isSafeInteger(now)
		) {
			throw new PublisherStateError("DELEGATION_INVALID");
		}
		const tokenHash = await hashRefreshToken(token);
		return this.ctx.storage.transactionSync(() => {
			const operation = this.#readRefreshOperation();
			const current = this.#readDelegation();
			if (
				!current ||
				operation.generation !== generation ||
				operation.token_hash !== tokenHash ||
				operation.delegation_version !== current.stateVersion ||
				operation.expires_at === null ||
				operation.expires_at <= now
			) {
				return null;
			}
			return current;
		});
	}

	async completeDelegationRefresh(
		input: CompleteDelegationRefreshInput,
	): Promise<CompleteDelegationRefreshResult> {
		this.#assertPublisherDid(input.publisherDid);
		const now = input.now ?? Date.now();
		if (
			!validPositiveInteger(input.generation) ||
			!TOKEN_PATTERN.test(input.token) ||
			!validPositiveInteger(input.expectedVersion) ||
			!validBoundedString(input.clientKeyId, 128) ||
			!validBoundedString(input.encryptedSession, MAX_CIPHERTEXT_CHARS) ||
			!validPositiveInteger(input.encryptionKeyVersion) ||
			!validHttpsOrigin(input.issuer) ||
			!validHttpsOrigin(input.pdsUrl) ||
			!validOptionalTimestamp(input.expiresAt) ||
			!validOptionalTimestamp(input.refreshBefore) ||
			!Number.isSafeInteger(now)
		) {
			throw new PublisherStateError("DELEGATION_INVALID");
		}
		const tokenHash = await hashRefreshToken(input.token);
		return this.ctx.storage.transactionSync(() => {
			const operation = this.#readRefreshOperation();
			const current = this.#readDelegation();
			if (
				!current ||
				current.stateVersion !== input.expectedVersion ||
				operation.generation !== input.generation ||
				operation.token_hash !== tokenHash ||
				operation.delegation_version !== input.expectedVersion ||
				operation.expires_at === null ||
				operation.expires_at <= now
			) {
				return { ok: false, code: "DELEGATION_CAS_REQUIRED" } as const;
			}
			this.ctx.storage.sql.exec(
				`UPDATE delegation SET
					client_key_id = ?, encrypted_session = ?, encryption_key_version = ?,
					issuer = ?, pds_url = ?, expires_at = ?, refresh_before = ?,
					status = 'active', state_version = state_version + 1, updated_at = ?
				 WHERE id = 1`,
				input.clientKeyId,
				input.encryptedSession,
				input.encryptionKeyVersion,
				input.issuer,
				input.pdsUrl,
				input.expiresAt,
				input.refreshBefore,
				now,
			);
			this.#clearRefreshOperation(now);
			this.#appendAudit(
				"delegation-refresh-completed",
				"system",
				"release-service",
				current.releaseNsid,
				now,
			);
			return { ok: true, delegation: this.#readDelegation()! } as const;
		});
	}

	async releaseDelegationRefresh(
		publisherDid: string,
		generation: number,
		token: string,
		now = Date.now(),
	): Promise<boolean> {
		this.#assertPublisherDid(publisherDid);
		if (
			!validPositiveInteger(generation) ||
			!TOKEN_PATTERN.test(token) ||
			!Number.isSafeInteger(now)
		) {
			throw new PublisherStateError("DELEGATION_INVALID");
		}
		const tokenHash = await hashRefreshToken(token);
		return this.ctx.storage.transactionSync(() => {
			const operation = this.#readRefreshOperation();
			if (operation.generation !== generation || operation.token_hash !== tokenHash) return false;
			this.#clearRefreshOperation(now);
			this.#appendAudit(
				"delegation-refresh-released",
				"system",
				"release-service",
				this.#readDelegation()?.releaseNsid ?? "delegation",
				now,
			);
			return true;
		});
	}

	requireDelegationReauthorization(
		publisherDid: string,
		expectedVersion: number,
		reasonCode: DelegationReauthorizationReason,
	): RequireDelegationReauthorizationResult {
		this.#assertPublisherDid(publisherDid);
		if (!validPositiveInteger(expectedVersion)) {
			throw new PublisherStateError("DELEGATION_INVALID");
		}
		return this.ctx.storage.transactionSync(() => {
			const current = this.#readDelegation();
			if (!current || current.stateVersion !== expectedVersion || current.status === "revoked") {
				return { ok: false, code: "DELEGATION_CAS_REQUIRED" } as const;
			}
			if (current.status === "reauthorization_required") {
				return { ok: true, delegation: current } as const;
			}
			const now = Date.now();
			this.ctx.storage.sql.exec(
				`UPDATE delegation SET
					status = 'reauthorization_required', state_version = state_version + 1, updated_at = ?
				 WHERE id = 1`,
				now,
			);
			this.#clearRefreshOperation(now);
			this.#appendAudit(
				"delegation-reauthorization-required",
				"system",
				"release-service",
				current.releaseNsid,
				now,
				reasonCode,
			);
			return { ok: true, delegation: this.#readDelegation()! } as const;
		});
	}

	revokeDelegation(
		publisherDid: string,
		expectedVersion: number,
		actorIdentity?: string,
	): RevokeDelegationResult {
		this.#assertPublisherDid(publisherDid);
		if (actorIdentity !== undefined && !ACTOR_IDENTITY_PATTERN.test(actorIdentity)) {
			throw new PublisherStateError("DELEGATION_INVALID");
		}
		return this.ctx.storage.transactionSync(() => {
			const now = Date.now();
			const current = this.#readDelegation();
			if (!current || current.stateVersion !== expectedVersion) {
				return { ok: false, code: "DELEGATION_CAS_REQUIRED" } as const;
			}
			const stateVersion = current.stateVersion + 1;
			this.ctx.storage.sql.exec(
				`UPDATE delegation SET
					status = 'revoked', encrypted_session = '', encryption_key_version = NULL,
					state_version = ?, updated_at = ? WHERE id = 1`,
				stateVersion,
				now,
			);
			this.#clearRefreshOperation(now);
			this.#appendAudit(
				"delegation-revoked",
				actorIdentity ? "access" : "publisher",
				actorIdentity ?? publisherDid,
				current.releaseNsid,
				now,
			);
			return { ok: true, delegation: this.#readDelegation()! } as const;
		});
	}

	#readDelegation(): StoredDelegation | null {
		const row = this.ctx.storage.sql
			.exec<DelegationRow>(
				`SELECT release_nsid, scope, client_key_id, encrypted_session,
				        encryption_key_version, issuer, pds_url, expires_at,
				        refresh_before, status, state_version
				 FROM delegation WHERE id = 1`,
			)
			.toArray()[0];
		return row
			? {
					releaseNsid: row.release_nsid,
					scope: row.scope,
					clientKeyId: row.client_key_id,
					encryptedSession: row.encrypted_session,
					encryptionKeyVersion: row.encryption_key_version,
					issuer: row.issuer,
					pdsUrl: row.pds_url,
					expiresAt: row.expires_at,
					refreshBefore: row.refresh_before,
					status: row.status,
					stateVersion: row.state_version,
				}
			: null;
	}

	#readRefreshOperation(): OperationRow {
		return this.ctx.storage.sql
			.exec<OperationRow>(
				`SELECT generation, token_hash, delegation_version, expires_at
				 FROM delegation_operations WHERE kind = 'refresh'`,
			)
			.one();
	}

	#readPublisherSessionOwner(): PublisherSessionOwnerRow | null {
		return (
			this.ctx.storage.sql
				.exec<PublisherSessionOwnerRow>(
					"SELECT did, status, session_epoch FROM publisher WHERE id = 1",
				)
				.toArray()[0] ?? null
		);
	}

	async #scheduleNextAlarm(now: number): Promise<void> {
		const candidates = this.ctx.storage.sql
			.exec<{
				operation_deadline: number | null;
				coordination_deadline: number | null;
				oauth_expiry: number | null;
				session_expiry: number | null;
				idempotency_expiry: number | null;
				rate_expiry: number | null;
				intent_expiry: number | null;
				connection_expiry: number | null;
				invitation_expiry: number | null;
			}>(
				`SELECT
					(SELECT MIN(scheduled_at) FROM deadlines) AS operation_deadline,
					(SELECT MIN(expires_at) FROM publication_coordinations) AS coordination_deadline,
					(SELECT MIN(expires_at) FROM oauth_states) AS oauth_expiry,
					(SELECT MIN(expires_at) FROM publisher_sessions) AS session_expiry,
					(SELECT MIN(expires_at) FROM intent_idempotency) AS idempotency_expiry,
					(SELECT MIN(expires_at) FROM intent_rate_idempotency) AS rate_expiry,
					(SELECT MIN(expires_at) FROM intents
					 WHERE state IN (
					   'received', 'verifying', 'verified', 'awaiting_approval', 'ready'
					 )) AS intent_expiry,
					(SELECT MIN(expires_at) FROM workflow_connection_requests
					 WHERE state = 'pending') AS connection_expiry,
					(SELECT MIN(expires_at) FROM workflow_connection_invitations)
					 AS invitation_expiry`,
			)
			.one();
		const deadlines = Object.values(candidates).filter(
			(value): value is number => typeof value === "number",
		);
		const deadline = deadlines.length === 0 ? null : Math.min(...deadlines);
		if (deadline === null) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		await this.ctx.storage.setAlarm(Math.max(now + 1, deadline));
	}

	override async alarm(): Promise<void> {
		const now = Date.now();
		this.#publicationCoordinations.recoverExpired(now);
		this.#publicationOperations.recoverExpired(now);
		const publisherDid = this.#objectName;
		if (publisherDid !== undefined) {
			for (const intent of this.#intents.listExpirable(now, MAINTENANCE_BATCH_SIZE)) {
				this.#intents.transition({
					publisherDid,
					intentId: intent.id,
					expectedState: intent.state,
					expectedGeneration: intent.stateGeneration,
					toState: "expired",
					transitionDigest: await expirationDigest(intent.id, intent.expiresAt),
					actorRealm: "system",
					actorIdentity: "release-service",
					reasonCode: "INTENT_EXPIRED",
					stateDataJson: '{"reasonCode":"INTENT_EXPIRED"}',
					now,
				});
			}
		}
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec("DELETE FROM oauth_states WHERE expires_at <= ?", now);
			this.ctx.storage.sql.exec("DELETE FROM publisher_sessions WHERE expires_at <= ?", now);
			this.ctx.storage.sql.exec("DELETE FROM intent_idempotency WHERE expires_at <= ?", now);
			this.ctx.storage.sql.exec("DELETE FROM intent_rate_idempotency WHERE expires_at <= ?", now);
			this.#workflowConnections.expire(now);
		});
		await this.#scheduleNextAlarm(now);
	}

	#clearRefreshOperation(now: number): void {
		this.ctx.storage.sql.exec(
			`UPDATE delegation_operations SET
				token_hash = NULL, delegation_version = NULL, expires_at = NULL, updated_at = ?
			 WHERE kind = 'refresh'`,
			now,
		);
	}
}
