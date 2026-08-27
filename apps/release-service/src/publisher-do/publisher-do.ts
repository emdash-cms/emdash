import { DurableObject } from "cloudflare:workers";

import {
	initializeIntentStateSchema,
	IntentStateStore,
	type CreateIntentInput,
	type CreateIntentResult,
	type IntentTransition,
	type StoredIntent,
	type TransitionIntentInput,
	type TransitionIntentResult,
} from "./intent-state.js";
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
	initializeVerificationStepSchema,
	VerificationStepStore,
	type PutVerificationStepInput,
	type PutVerificationStepResult,
	type StoredVerificationStep,
	type VerificationStepName,
} from "./verification-step.js";
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
	StoredIntent,
	TransitionIntentInput,
	TransitionIntentResult,
} from "./intent-state.js";
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

const DID_PATTERN = /^did:[a-z][a-z0-9]*:[A-Za-z0-9._:%-]+$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_CIPHERTEXT_CHARS = 1_500_000;
const MAX_REFRESH_LEASE_MS = 5 * 60_000;
const MAX_PUBLISHER_SESSION_MS = 24 * 60 * 60_000;
const REFRESH_TOKEN_BYTES = 32;
const BASE64_PADDING_PATTERN = /=+$/;

export type PublisherStateErrorCode =
	| "PUBLISHER_DID_INVALID"
	| "PUBLISHER_DID_MISMATCH"
	| "OAUTH_STATE_INVALID"
	| "OAUTH_STATE_EXISTS"
	| "DELEGATION_INVALID"
	| "DELEGATION_CAS_REQUIRED"
	| "DELEGATION_UNAVAILABLE"
	| "PUBLISHER_SESSION_INVALID";

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
	clientKeyId: string;
	redirectTarget: string;
	expiresAt: number;
}

export interface StoredOAuthState {
	encryptedState: string;
	encryptionKeyVersion: number;
	clientKeyId: string;
	redirectTarget: string;
	expiresAt: number;
}

export type PutOAuthStateResult = { ok: true } | { ok: false; code: "OAUTH_STATE_EXISTS" };

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
	| { ok: false; code: "PUBLISHER_SESSION_EXISTS" | "PUBLISHER_SUSPENDED" };

export type ValidatePublisherSessionResult =
	| { ok: true; session: StoredPublisherSession }
	| {
			ok: false;
			code: "PUBLISHER_SESSION_INVALID" | "PUBLISHER_SESSION_EXPIRED" | "PUBLISHER_SUSPENDED";
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

export class PublisherDurableObject extends DurableObject<Env> {
	readonly #objectName: string | undefined;
	readonly #workloadPolicies: WorkloadPolicyStore;
	readonly #intents: IntentStateStore;
	readonly #publicationMaterializations: PublicationMaterializationStore;
	readonly #publicationOperations: PublicationOperationStore;
	readonly #verificationSteps: VerificationStepStore;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#objectName = ctx.id.name;
		this.#workloadPolicies = new WorkloadPolicyStore(ctx.storage);
		this.#intents = new IntentStateStore(ctx.storage);
		this.#publicationMaterializations = new PublicationMaterializationStore(ctx.storage);
		this.#publicationOperations = new PublicationOperationStore(ctx.storage);
		this.#verificationSteps = new VerificationStepStore(ctx.storage);
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
				encryption_key_version INTEGER,
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
		initializePublicationMaterializationSchema(this.ctx.storage);
		initializePublicationOperationSchema(this.ctx.storage);
		initializeVerificationStepSchema(this.ctx.storage);
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
		actorRealm: "publisher" | "system",
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

	putWorkloadPolicy(input: PutWorkloadPolicyInput): PutWorkloadPolicyResult {
		this.#assertPublisherDid(input.publisherDid);
		return this.#workloadPolicies.put(input);
	}

	getWorkloadPolicy(publisherDid: string, packageSlug: string): StoredWorkloadPolicy | null {
		this.#assertPublisherDid(publisherDid);
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

	async createIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
		this.#assertPublisherDid(input.publisherDid);
		const result = this.#intents.create(input);
		await this.#scheduleNextAlarm(input.now ?? Date.now());
		return result;
	}

	transitionIntent(input: TransitionIntentInput): TransitionIntentResult {
		this.#assertPublisherDid(input.publisherDid);
		return this.#intents.transition(input);
	}

	getIntent(publisherDid: string, intentId: string): StoredIntent | null {
		this.#assertPublisherDid(publisherDid);
		return this.#intents.get(intentId);
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
		now = Date.now(),
	): Promise<BeginPublicationOperationResult> {
		this.#assertPublisherDid(publisherDid);
		const result = await this.#publicationOperations.begin(
			publisherDid,
			intentId,
			expectedIntentGeneration,
			leaseMs,
			now,
		);
		await this.#scheduleNextAlarm(now);
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
		const result = await this.#publicationOperations.advancePhase(input);
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
		await this.#scheduleNextAlarm(now);
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

	revokeAllPublisherSessions(publisherDid: string): number | null {
		this.#assertPublisherObjectName(publisherDid);
		return this.ctx.storage.transactionSync(() => {
			const owner = this.#readPublisherSessionOwner();
			if (!owner) return null;
			const nextEpoch = owner.session_epoch + 1;
			const now = Date.now();
			this.ctx.storage.sql.exec("UPDATE publisher SET session_epoch = ? WHERE id = 1", nextEpoch);
			this.ctx.storage.sql.exec("DELETE FROM publisher_sessions");
			this.#appendAudit("publisher-sessions-revoked", "publisher", publisherDid, publisherDid, now);
			return nextEpoch;
		});
	}

	async putOAuthState(input: PutOAuthStateInput): Promise<PutOAuthStateResult> {
		this.#assertPublisherDid(input.publisherDid);
		if (
			!HASH_PATTERN.test(input.stateHash) ||
			!validBoundedString(input.encryptedState, MAX_CIPHERTEXT_CHARS) ||
			!validPositiveInteger(input.encryptionKeyVersion) ||
			!validBoundedString(input.clientKeyId, 128) ||
			!validRelativeRedirectPath(input.redirectTarget) ||
			!Number.isSafeInteger(input.expiresAt) ||
			input.expiresAt <= Date.now()
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
			this.ctx.storage.sql.exec(
				`INSERT INTO oauth_states (
						state_hash, encrypted_state, encryption_key_version, client_key_id,
						redirect_target, expires_at, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				input.stateHash,
				input.encryptedState,
				input.encryptionKeyVersion,
				input.clientKeyId,
				input.redirectTarget,
				input.expiresAt,
				Date.now(),
			);
			this.#appendAudit(
				"oauth-state-created",
				"publisher",
				input.publisherDid,
				input.stateHash,
				Date.now(),
			);
			return { ok: true } as const;
		});
		await this.#scheduleNextAlarm(Date.now());
		return result;
	}

	consumeOAuthState(
		publisherDid: string,
		stateHash: string,
		now = Date.now(),
	): StoredOAuthState | null {
		this.#assertPublisherDid(publisherDid);
		if (!HASH_PATTERN.test(stateHash) || !Number.isSafeInteger(now)) {
			throw new PublisherStateError("OAUTH_STATE_INVALID");
		}
		return this.ctx.storage.transactionSync(() => {
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

	revokeDelegation(publisherDid: string, expectedVersion: number): RevokeDelegationResult {
		this.#assertPublisherDid(publisherDid);
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
			this.#appendAudit("delegation-revoked", "publisher", publisherDid, current.releaseNsid, now);
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
		const stateDeadline = this.ctx.storage.sql
			.exec<{ deadline: number | null }>(
				`SELECT MIN(expires_at) AS deadline FROM (
					SELECT expires_at FROM oauth_states
					UNION ALL SELECT expires_at FROM publisher_sessions
					UNION ALL SELECT expires_at FROM intent_idempotency
				)`,
			)
			.one().deadline;
		const operationDeadline = this.#publicationOperations.nextDeadline();
		const deadline =
			stateDeadline === null
				? operationDeadline
				: operationDeadline === null
					? stateDeadline
					: Math.min(stateDeadline, operationDeadline);
		if (deadline === null) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		await this.ctx.storage.setAlarm(Math.max(now + 1, deadline));
	}

	override async alarm(): Promise<void> {
		const now = Date.now();
		this.#publicationOperations.recoverExpired(now);
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec("DELETE FROM oauth_states WHERE expires_at <= ?", now);
			this.ctx.storage.sql.exec("DELETE FROM publisher_sessions WHERE expires_at <= ?", now);
			this.ctx.storage.sql.exec("DELETE FROM intent_idempotency WHERE expires_at <= ?", now);
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
