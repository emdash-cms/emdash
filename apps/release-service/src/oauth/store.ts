import {
	MemoryStore,
	type OAuthClientStores,
	type Store,
	type StoredSession,
	type StoredState,
} from "@atcute/oauth-node-client";
import { ulid } from "ulidx";

import type { OAuthConfiguration } from "../config.js";
import type {
	EncryptionContext,
	EnvelopeEncryption,
	OptionalOwnerEncryptionPurpose,
} from "../crypto/encryption.js";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const BASE64_PADDING_PATTERN = /=+$/;
const MAX_DELEGATION_LEASE_MS = 5 * 60_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Did = `did:${string}:${string}`;

export type OAuthPurpose = "console_login" | "approver_identity" | "release_delegation";
export type OAuthCustodyErrorCode =
	| "OAUTH_CLIENT_KEY_UNAVAILABLE"
	| "OAUTH_CLIENT_AUTH_INVALID"
	| "OAUTH_SCOPE_INVALID"
	| "OAUTH_IDENTITY_MISMATCH"
	| "OAUTH_STATE_INVALID"
	| "OAUTH_SESSION_INVALID"
	| "OAUTH_REDIRECT_INVALID"
	| "OAUTH_DELEGATION_CAS_REQUIRED";

const ERROR_MESSAGES: Record<OAuthCustodyErrorCode, string> = {
	OAUTH_CLIENT_KEY_UNAVAILABLE: "OAuth client key is unavailable",
	OAUTH_CLIENT_AUTH_INVALID: "OAuth client authentication is invalid",
	OAUTH_SCOPE_INVALID: "OAuth scope is invalid",
	OAUTH_IDENTITY_MISMATCH: "OAuth identity does not match",
	OAUTH_STATE_INVALID: "OAuth state is invalid",
	OAUTH_SESSION_INVALID: "OAuth session is invalid",
	OAUTH_REDIRECT_INVALID: "OAuth redirect is invalid",
	OAUTH_DELEGATION_CAS_REQUIRED: "OAuth delegation requires a compare-and-set update",
};

export class OAuthCustodyError extends Error {
	readonly code: OAuthCustodyErrorCode;
	readonly reauthorizationRequired: boolean;

	constructor(code: OAuthCustodyErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = "OAuthCustodyError";
		this.code = code;
		this.reauthorizationRequired = code === "OAUTH_CLIENT_KEY_UNAVAILABLE";
	}
}

export type OAuthStoreOptions =
	| { purpose: "console_login"; expectedDid: Did | null; redirectTarget: string }
	| { purpose: "approver_identity"; expectedDid: Did; redirectTarget: string }
	| { purpose: "release_delegation"; expectedDid: Did; redirectTarget: string };

export interface OAuthUserState {
	redirectTarget: string;
}

type PublisherPdsUpdate =
	| { pdsUrl?: never; pdsResolvedAt?: never }
	| { pdsUrl: string; pdsResolvedAt: Date }
	| { pdsUrl: null; pdsResolvedAt?: Date | null }
	| { pdsUrl?: string | null; pdsResolvedAt: null };

interface TransactionRow {
	id: string;
	expected_did: string | null;
	client_key_id: string;
	encrypted_state: string;
	redirect_target: string;
	expires_at: string;
}

interface DelegationRow {
	id: string;
	publisher_did: string;
	release_nsid: string;
	encrypted_session: string | null;
	client_key_id: string;
	scope: string;
	status: "active" | "refreshing" | "reauthorization_required" | "revoked";
	state_version: number;
	lease_owner: string | null;
	lease_expires_at: string | null;
	refresh_before: string | null;
}

export interface Delegation extends DelegationRow {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDid(value: unknown): value is Did {
	return typeof value === "string" && DID_PATTERN.test(value);
}

function getClientKeyId(value: { authMethod: StoredState["authMethod"] }): string {
	if (
		value.authMethod.method !== "private_key_jwt" ||
		typeof value.authMethod.kid !== "string" ||
		value.authMethod.kid.length === 0
	) {
		throw new OAuthCustodyError("OAUTH_CLIENT_AUTH_INVALID");
	}
	return value.authMethod.kid;
}

function assertDpopKey(value: unknown): asserts value is StoredSession["dpopKey"] {
	if (
		!isRecord(value) ||
		value["kty"] !== "EC" ||
		value["crv"] !== "P-256" ||
		value["alg"] !== "ES256" ||
		typeof value["x"] !== "string" ||
		typeof value["y"] !== "string" ||
		typeof value["d"] !== "string"
	) {
		throw new OAuthCustodyError("OAUTH_SESSION_INVALID");
	}
}

function parseStoredState(value: string): StoredState {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new OAuthCustodyError("OAUTH_STATE_INVALID");
	}
	if (
		!isRecord(parsed) ||
		!isRecord(parsed["authMethod"]) ||
		parsed["authMethod"]["method"] !== "private_key_jwt" ||
		typeof parsed["authMethod"]["kid"] !== "string" ||
		typeof parsed["pkceVerifier"] !== "string" ||
		typeof parsed["issuer"] !== "string" ||
		typeof parsed["redirectUri"] !== "string" ||
		(typeof parsed["sub"] !== "undefined" && !isDid(parsed["sub"])) ||
		typeof parsed["expiresAt"] !== "number" ||
		!Number.isFinite(parsed["expiresAt"])
	) {
		throw new OAuthCustodyError("OAUTH_STATE_INVALID");
	}
	try {
		assertDpopKey(parsed["dpopKey"]);
	} catch {
		throw new OAuthCustodyError("OAUTH_STATE_INVALID");
	}
	return {
		dpopKey: parsed["dpopKey"],
		authMethod: { method: "private_key_jwt", kid: parsed["authMethod"]["kid"] },
		pkceVerifier: parsed["pkceVerifier"],
		issuer: parsed["issuer"],
		redirectUri: parsed["redirectUri"],
		...(parsed["sub"] ? { sub: parsed["sub"] } : {}),
		...("userState" in parsed ? { userState: parsed["userState"] } : {}),
		expiresAt: parsed["expiresAt"],
	};
}

function parseStoredSession(value: string): StoredSession {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new OAuthCustodyError("OAUTH_SESSION_INVALID");
	}
	if (
		!isRecord(parsed) ||
		!isRecord(parsed["authMethod"]) ||
		parsed["authMethod"]["method"] !== "private_key_jwt" ||
		typeof parsed["authMethod"]["kid"] !== "string" ||
		!isRecord(parsed["tokenSet"]) ||
		typeof parsed["tokenSet"]["iss"] !== "string" ||
		!isDid(parsed["tokenSet"]["sub"]) ||
		typeof parsed["tokenSet"]["aud"] !== "string" ||
		typeof parsed["tokenSet"]["scope"] !== "string" ||
		typeof parsed["tokenSet"]["access_token"] !== "string" ||
		(typeof parsed["tokenSet"]["refresh_token"] !== "undefined" &&
			typeof parsed["tokenSet"]["refresh_token"] !== "string") ||
		parsed["tokenSet"]["token_type"] !== "DPoP" ||
		(typeof parsed["tokenSet"]["expires_at"] !== "undefined" &&
			typeof parsed["tokenSet"]["expires_at"] !== "number")
	) {
		throw new OAuthCustodyError("OAUTH_SESSION_INVALID");
	}
	assertDpopKey(parsed["dpopKey"]);
	return {
		dpopKey: parsed["dpopKey"],
		authMethod: { method: "private_key_jwt", kid: parsed["authMethod"]["kid"] },
		tokenSet: {
			iss: parsed["tokenSet"]["iss"],
			sub: parsed["tokenSet"]["sub"],
			aud: parsed["tokenSet"]["aud"],
			scope: parsed["tokenSet"]["scope"],
			access_token: parsed["tokenSet"]["access_token"],
			...(parsed["tokenSet"]["refresh_token"]
				? { refresh_token: parsed["tokenSet"]["refresh_token"] }
				: {}),
			...(typeof parsed["tokenSet"]["expires_at"] === "number"
				? { expires_at: parsed["tokenSet"]["expires_at"] }
				: {}),
			token_type: "DPoP",
		},
	};
}

async function hashOpaque(value: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
	let binary = "";
	for (const byte of digest) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(BASE64_PADDING_PATTERN, "");
}

function transactionEncryptionPurpose(purpose: OAuthPurpose): OptionalOwnerEncryptionPurpose {
	switch (purpose) {
		case "console_login":
			return "oauth-console-transaction";
		case "approver_identity":
			return "oauth-approver-transaction";
		case "release_delegation":
			return "oauth-delegation-transaction";
	}
}

function canonicalizeRedirectTarget(value: string, publicOrigin: string): string {
	if (typeof value !== "string") throw new OAuthCustodyError("OAUTH_REDIRECT_INVALID");
	let hasControlCharacter = false;
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit <= 0x1f || codeUnit === 0x7f) {
			hasControlCharacter = true;
			break;
		}
	}
	if (
		!value.startsWith("/") ||
		value.startsWith("//") ||
		value.includes("\\") ||
		hasControlCharacter
	) {
		throw new OAuthCustodyError("OAUTH_REDIRECT_INVALID");
	}
	try {
		const url = new URL(value, publicOrigin);
		if (url.origin !== publicOrigin) throw new OAuthCustodyError("OAUTH_REDIRECT_INVALID");
		return `${url.pathname}${url.search}${url.hash}`;
	} catch (error) {
		if (error instanceof OAuthCustodyError) throw error;
		throw new OAuthCustodyError("OAUTH_REDIRECT_INVALID");
	}
}

function parseOAuthUserState(
	value: unknown,
	expectedRedirectTarget: string,
	publicOrigin: string,
): OAuthUserState {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== 1 ||
		typeof value["redirectTarget"] !== "string" ||
		canonicalizeRedirectTarget(value["redirectTarget"], publicOrigin) !== expectedRedirectTarget
	) {
		throw new OAuthCustodyError("OAUTH_REDIRECT_INVALID");
	}
	return { redirectTarget: expectedRedirectTarget };
}

export class OAuthCustodyRepository {
	readonly #db: D1Database;
	readonly #encryption: EnvelopeEncryption;
	readonly #oauth: OAuthConfiguration;

	constructor(db: D1Database, encryption: EnvelopeEncryption, oauth: OAuthConfiguration) {
		this.#db = db;
		this.#encryption = encryption;
		this.#oauth = oauth;
	}

	async upsertPublisher(
		input: {
			did: string;
			handle?: string | null;
			now?: Date;
		} & PublisherPdsUpdate,
	): Promise<void> {
		if (!isDid(input.did)) throw new OAuthCustodyError("OAUTH_IDENTITY_MISMATCH");
		const now = (input.now ?? new Date()).toISOString();
		const hasHandle = input.handle !== undefined;
		const hasPdsUpdate = input.pdsUrl !== undefined || input.pdsResolvedAt !== undefined;
		let pdsUrl: string | null = null;
		let pdsResolvedAt: string | null = null;
		if (hasPdsUpdate && input.pdsUrl !== null && input.pdsResolvedAt !== null) {
			if (
				typeof input.pdsUrl !== "string" ||
				!(input.pdsResolvedAt instanceof Date) ||
				!Number.isFinite(input.pdsResolvedAt.getTime())
			) {
				throw new TypeError("PDS URL and resolution time must be set together");
			}
			pdsUrl = input.pdsUrl;
			pdsResolvedAt = input.pdsResolvedAt.toISOString();
		}
		await this.#db
			.prepare(
				`INSERT INTO publisher_accounts (
					did, handle, pds_url, pds_resolved_at, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(did) DO UPDATE SET
					handle = CASE WHEN ? THEN excluded.handle ELSE publisher_accounts.handle END,
					pds_url = CASE WHEN ? THEN excluded.pds_url ELSE publisher_accounts.pds_url END,
					pds_resolved_at = CASE WHEN ? THEN excluded.pds_resolved_at ELSE publisher_accounts.pds_resolved_at END,
					updated_at = excluded.updated_at`,
			)
			.bind(
				input.did,
				input.handle ?? null,
				pdsUrl,
				pdsResolvedAt,
				now,
				now,
				hasHandle ? 1 : 0,
				hasPdsUpdate ? 1 : 0,
				hasPdsUpdate ? 1 : 0,
			)
			.run();
	}

	async putTransaction(rawState: string, state: StoredState, options: OAuthStoreOptions) {
		const publicOrigin = this.#oauth.clientMetadata.client_uri;
		const redirectTarget = canonicalizeRedirectTarget(options.redirectTarget, publicOrigin);
		const userState = parseOAuthUserState(state.userState, redirectTarget, publicOrigin);
		const keyId = getClientKeyId(state);
		this.assertClientKeyAvailable(keyId);
		this.assertSeparateDpopKey(state.dpopKey);
		if (options.expectedDid && options.expectedDid !== state.sub) {
			throw new OAuthCustodyError("OAUTH_IDENTITY_MISMATCH");
		}
		if (!this.#oauth.clientMetadata.redirect_uris.includes(state.redirectUri)) {
			throw new OAuthCustodyError("OAUTH_REDIRECT_INVALID");
		}
		const id = ulid();
		const context: EncryptionContext = {
			purpose: transactionEncryptionPurpose(options.purpose),
			table: "oauth_transactions",
			primaryKey: id,
			ownerDid: options.expectedDid,
		};
		const encrypted = await this.#encryption.encrypt(
			encoder.encode(JSON.stringify({ ...state, userState })),
			context,
		);
		await this.#db
			.prepare(
				`INSERT INTO oauth_transactions (
					id, state_hash, purpose, expected_did, client_key_id, encrypted_state,
					encryption_key_version, redirect_target, expires_at, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				id,
				await hashOpaque(rawState),
				options.purpose,
				options.expectedDid,
				keyId,
				encrypted.envelope,
				encrypted.keyVersion,
				redirectTarget,
				new Date(state.expiresAt).toISOString(),
				new Date().toISOString(),
			)
			.run();
	}

	async getTransaction(
		rawState: string,
		options: OAuthStoreOptions,
	): Promise<StoredState | undefined> {
		const publicOrigin = this.#oauth.clientMetadata.client_uri;
		const redirectTarget = canonicalizeRedirectTarget(options.redirectTarget, publicOrigin);
		// atcute deletes state after reading it, so consume it here atomically to close callback races.
		const row = await this.#db
			.prepare(
				`DELETE FROM oauth_transactions
				WHERE state_hash = ? AND purpose = ? AND expected_did IS ? AND redirect_target = ?
				RETURNING id, expected_did, client_key_id, encrypted_state, redirect_target, expires_at`,
			)
			.bind(await hashOpaque(rawState), options.purpose, options.expectedDid, redirectTarget)
			.first<TransactionRow>();
		if (!row) return undefined;
		if (row.expires_at <= new Date().toISOString()) {
			return undefined;
		}
		this.assertClientKeyAvailable(row.client_key_id);
		const plaintext = await this.#encryption.decrypt(row.encrypted_state, {
			purpose: transactionEncryptionPurpose(options.purpose),
			table: "oauth_transactions",
			primaryKey: row.id,
			ownerDid: row.expected_did,
		});
		const state = parseStoredState(decoder.decode(plaintext));
		if (getClientKeyId(state) !== row.client_key_id) {
			throw new OAuthCustodyError("OAUTH_STATE_INVALID");
		}
		return {
			...state,
			userState: parseOAuthUserState(state.userState, row.redirect_target, publicOrigin),
		};
	}

	async deleteTransaction(rawState: string, options: OAuthStoreOptions): Promise<void> {
		const redirectTarget = canonicalizeRedirectTarget(
			options.redirectTarget,
			this.#oauth.clientMetadata.client_uri,
		);
		await this.#db
			.prepare(
				"DELETE FROM oauth_transactions WHERE state_hash = ? AND purpose = ? AND expected_did IS ? AND redirect_target = ?",
			)
			.bind(await hashOpaque(rawState), options.purpose, options.expectedDid, redirectTarget)
			.run();
	}

	async clearTransactions(options: OAuthStoreOptions): Promise<void> {
		const redirectTarget = canonicalizeRedirectTarget(
			options.redirectTarget,
			this.#oauth.clientMetadata.client_uri,
		);
		await this.#db
			.prepare(
				"DELETE FROM oauth_transactions WHERE purpose = ? AND expected_did IS ? AND redirect_target = ?",
			)
			.bind(options.purpose, options.expectedDid, redirectTarget)
			.run();
	}

	async createConsoleSession(input: {
		publisherDid: string;
		token: string;
		csrfSecret: string;
		expiresAt: Date;
		now?: Date;
	}) {
		const id = ulid();
		const encrypted = await this.#encryption.encrypt(encoder.encode(input.csrfSecret), {
			purpose: "csrf-secret",
			table: "console_sessions",
			primaryKey: id,
			ownerDid: input.publisherDid,
		});
		const now = (input.now ?? new Date()).toISOString();
		await this.#db
			.prepare(
				`INSERT INTO console_sessions (
					id, token_hash, publisher_did, encrypted_csrf_secret, encryption_key_version,
					expires_at, created_at, last_seen_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				id,
				await hashOpaque(input.token),
				input.publisherDid,
				encrypted.envelope,
				encrypted.keyVersion,
				input.expiresAt.toISOString(),
				now,
				now,
			)
			.run();
		return { id };
	}

	async getConsoleSession(token: string, publisherDid: string) {
		const row = await this.#db
			.prepare(
				`SELECT id, publisher_did, encrypted_csrf_secret, expires_at
				FROM console_sessions WHERE token_hash = ? AND publisher_did = ?`,
			)
			.bind(await hashOpaque(token), publisherDid)
			.first<{
				id: string;
				publisher_did: string;
				encrypted_csrf_secret: string;
				expires_at: string;
			}>();
		if (!row) return undefined;
		if (row.expires_at <= new Date().toISOString()) {
			await this.#db.prepare("DELETE FROM console_sessions WHERE id = ?").bind(row.id).run();
			return undefined;
		}
		const csrfSecret = decoder.decode(
			await this.#encryption.decrypt(row.encrypted_csrf_secret, {
				purpose: "csrf-secret",
				table: "console_sessions",
				primaryKey: row.id,
				ownerDid: row.publisher_did,
			}),
		);
		return { id: row.id, publisherDid: row.publisher_did, csrfSecret };
	}

	async putDelegation(publisherDid: `did:${string}:${string}`, session: StoredSession) {
		this.validateDelegationSession(publisherDid, session);
		const existing = await this.getDelegationByPublisher(publisherDid);
		if (existing) throw new OAuthCustodyError("OAUTH_DELEGATION_CAS_REQUIRED");
		const id = ulid();
		const encrypted = await this.encryptSession(id, publisherDid, session);
		const now = new Date().toISOString();
		await this.#db
			.prepare(
				`INSERT INTO delegations (
					id, publisher_did, release_nsid, encrypted_session, encryption_key_version,
					client_key_id, scope, status, refresh_before, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
			)
			.bind(
				id,
				publisherDid,
				this.#oauth.releaseNsid,
				encrypted.envelope,
				encrypted.keyVersion,
				getClientKeyId(session),
				this.#oauth.releaseScope,
				session.tokenSet.expires_at ? new Date(session.tokenSet.expires_at).toISOString() : null,
				now,
				now,
			)
			.run();
		return id;
	}

	async getDelegationByPublisher(publisherDid: string): Promise<Delegation | undefined> {
		return (
			(await this.#db
				.prepare(
					`SELECT id, publisher_did, release_nsid, encrypted_session, client_key_id,
						scope, status, state_version, lease_owner, lease_expires_at, refresh_before
					FROM delegations
					WHERE publisher_did = ? AND release_nsid = ? AND revoked_at IS NULL`,
				)
				.bind(publisherDid, this.#oauth.releaseNsid)
				.first<DelegationRow>()) ?? undefined
		);
	}

	async getDelegation(id: string, publisherDid: string): Promise<Delegation | undefined> {
		return (
			(await this.#db
				.prepare(
					`SELECT id, publisher_did, release_nsid, encrypted_session, client_key_id,
						scope, status, state_version, lease_owner, lease_expires_at, refresh_before
					FROM delegations WHERE id = ? AND publisher_did = ?`,
				)
				.bind(id, publisherDid)
				.first<DelegationRow>()) ?? undefined
		);
	}

	async getDelegationSession(publisherDid: `did:${string}:${string}`) {
		const row = await this.#db
			.prepare(
				`SELECT id, publisher_did, release_nsid, encrypted_session, client_key_id,
					scope, status, state_version, lease_owner, lease_expires_at, refresh_before
				FROM delegations
				WHERE publisher_did = ? AND release_nsid = ? AND status = 'active'
					AND lease_owner IS NULL AND lease_expires_at IS NULL AND revoked_at IS NULL`,
			)
			.bind(publisherDid, this.#oauth.releaseNsid)
			.first<DelegationRow>();
		if (!row?.encrypted_session) return undefined;
		if (!this.#oauth.hasAssertionKey(row.client_key_id)) {
			const transitioned = await this.transitionMissingClientKeyCas(row, null);
			if (transitioned) throw new OAuthCustodyError("OAUTH_CLIENT_KEY_UNAVAILABLE");
			return undefined;
		}
		return this.decryptDelegationSession(row, publisherDid);
	}

	async getDelegationSessionForRefresh(input: {
		id: string;
		publisherDid: Did;
		expectedVersion: number;
		leaseOwner: string;
	}): Promise<StoredSession | undefined> {
		const now = new Date().toISOString();
		const row = await this.#db
			.prepare(
				`SELECT id, publisher_did, release_nsid, encrypted_session, client_key_id,
					scope, status, state_version, lease_owner, lease_expires_at, refresh_before
				FROM delegations
				WHERE id = ? AND publisher_did = ? AND release_nsid = ? AND state_version = ?
					AND status = 'refreshing' AND lease_owner = ? AND lease_expires_at > ?
					AND revoked_at IS NULL`,
			)
			.bind(
				input.id,
				input.publisherDid,
				this.#oauth.releaseNsid,
				input.expectedVersion,
				input.leaseOwner,
				now,
			)
			.first<DelegationRow>();
		if (!row?.encrypted_session) return undefined;
		if (!this.#oauth.hasAssertionKey(row.client_key_id)) {
			const transitioned = await this.transitionMissingClientKeyCas(row, input.leaseOwner);
			if (transitioned) throw new OAuthCustodyError("OAUTH_CLIENT_KEY_UNAVAILABLE");
			return undefined;
		}
		return this.decryptDelegationSession(row, input.publisherDid);
	}

	async decryptDelegationSession(row: DelegationRow, publisherDid: Did): Promise<StoredSession> {
		if (!row.encrypted_session) throw new OAuthCustodyError("OAUTH_SESSION_INVALID");
		const plaintext = await this.#encryption.decrypt(row.encrypted_session, {
			purpose: "oauth-session",
			table: "delegations",
			primaryKey: row.id,
			ownerDid: publisherDid,
		});
		const session = parseStoredSession(decoder.decode(plaintext));
		if (getClientKeyId(session) !== row.client_key_id) {
			throw new OAuthCustodyError("OAUTH_SESSION_INVALID");
		}
		this.validateDelegationSession(publisherDid, session);
		return session;
	}

	async transitionMissingClientKeyCas(
		row: DelegationRow,
		leaseOwner: string | null,
	): Promise<boolean> {
		const now = new Date().toISOString();
		const statement = leaseOwner
			? this.#db
					.prepare(
						`UPDATE delegations SET
							status = 'reauthorization_required', lease_owner = NULL, lease_expires_at = NULL,
							state_version = state_version + 1, updated_at = ?
						WHERE id = ? AND publisher_did = ? AND state_version = ?
							AND status = 'refreshing' AND lease_owner = ? AND lease_expires_at > ?
							AND revoked_at IS NULL`,
					)
					.bind(now, row.id, row.publisher_did, row.state_version, leaseOwner, now)
			: this.#db
					.prepare(
						`UPDATE delegations SET
							status = 'reauthorization_required', lease_owner = NULL, lease_expires_at = NULL,
							state_version = state_version + 1, updated_at = ?
						WHERE id = ? AND publisher_did = ? AND state_version = ?
							AND status = 'active' AND lease_owner IS NULL AND lease_expires_at IS NULL
							AND revoked_at IS NULL`,
					)
					.bind(now, row.id, row.publisher_did, row.state_version);
		const result = await statement.run();
		return result.meta.changes === 1;
	}

	async revokeDelegation(publisherDid: string): Promise<void> {
		const now = new Date().toISOString();
		await this.#db
			.prepare(
				`UPDATE delegations SET
					status = 'revoked', encrypted_session = NULL, encryption_key_version = NULL,
					lease_owner = NULL, lease_expires_at = NULL, revoked_at = ?, updated_at = ?,
					state_version = state_version + 1
				WHERE publisher_did = ? AND release_nsid = ? AND revoked_at IS NULL`,
			)
			.bind(now, now, publisherDid, this.#oauth.releaseNsid)
			.run();
	}

	async claimDelegationLeaseCas(input: {
		id: string;
		publisherDid: string;
		expectedVersion: number;
		leaseOwner: string;
		leaseExpiresAt: Date;
	}): Promise<boolean> {
		const nowMs = Date.now();
		const leaseExpiresAtMs = input.leaseExpiresAt.getTime();
		if (
			!Number.isFinite(leaseExpiresAtMs) ||
			leaseExpiresAtMs <= nowMs ||
			leaseExpiresAtMs - nowMs > MAX_DELEGATION_LEASE_MS
		) {
			return false;
		}
		const now = new Date(nowMs).toISOString();
		const result = await this.#db
			.prepare(
				`UPDATE delegations SET
					status = 'refreshing', lease_owner = ?, lease_expires_at = ?,
					state_version = state_version + 1, updated_at = ?
				WHERE id = ? AND publisher_did = ? AND release_nsid = ? AND state_version = ?
					AND status = 'active' AND lease_owner IS NULL AND revoked_at IS NULL`,
			)
			.bind(
				input.leaseOwner,
				new Date(leaseExpiresAtMs).toISOString(),
				now,
				input.id,
				input.publisherDid,
				this.#oauth.releaseNsid,
				input.expectedVersion,
			)
			.run();
		return result.meta.changes === 1;
	}

	async storeDelegationSessionCas(input: {
		id: string;
		publisherDid: `did:${string}:${string}`;
		expectedVersion: number;
		leaseOwner: string;
		session: StoredSession;
		refreshBefore: Date;
	}): Promise<boolean> {
		this.validateDelegationSession(input.publisherDid, input.session);
		const encrypted = await this.encryptSession(input.id, input.publisherDid, input.session);
		const now = new Date().toISOString();
		const result = await this.#db
			.prepare(
				`UPDATE delegations SET
					encrypted_session = ?, encryption_key_version = ?, client_key_id = ?,
					status = 'active', lease_owner = NULL, lease_expires_at = NULL,
					last_refreshed_at = ?, refresh_before = ?, updated_at = ?,
					state_version = state_version + 1
				WHERE id = ? AND publisher_did = ? AND release_nsid = ? AND state_version = ?
					AND status = 'refreshing' AND lease_owner = ? AND lease_expires_at > ?
					AND revoked_at IS NULL`,
			)
			.bind(
				encrypted.envelope,
				encrypted.keyVersion,
				getClientKeyId(input.session),
				now,
				input.refreshBefore.toISOString(),
				now,
				input.id,
				input.publisherDid,
				this.#oauth.releaseNsid,
				input.expectedVersion,
				input.leaseOwner,
				now,
			)
			.run();
		return result.meta.changes === 1;
	}

	assertClientKeyAvailable(keyId: string): void {
		if (!this.#oauth.hasAssertionKey(keyId)) {
			throw new OAuthCustodyError("OAUTH_CLIENT_KEY_UNAVAILABLE");
		}
	}

	validateDelegationSession(publisherDid: `did:${string}:${string}`, session: StoredSession): void {
		this.validateSession(publisherDid, session, this.#oauth.releaseScope);
	}

	validateIdentitySession(
		did: `did:${string}:${string}`,
		expectedDid: `did:${string}:${string}` | null,
		session: StoredSession,
	): void {
		if (expectedDid && did !== expectedDid) {
			throw new OAuthCustodyError("OAUTH_IDENTITY_MISMATCH");
		}
		this.validateSession(did, session, "atproto");
	}

	validateSession(
		did: `did:${string}:${string}`,
		session: StoredSession,
		expectedScope: string,
	): void {
		const keyId = getClientKeyId(session);
		this.assertClientKeyAvailable(keyId);
		if (session.tokenSet.sub !== did) {
			throw new OAuthCustodyError("OAUTH_IDENTITY_MISMATCH");
		}
		if (session.tokenSet.scope !== expectedScope) {
			throw new OAuthCustodyError("OAUTH_SCOPE_INVALID");
		}
		assertDpopKey(session.dpopKey);
		this.assertSeparateDpopKey(session.dpopKey);
	}

	assertSeparateDpopKey(dpopKey: StoredSession["dpopKey"]): void {
		if (
			dpopKey.kty === "EC" &&
			this.#oauth.assertionKeys.some(
				(key) => key.kty === "EC" && key.x === dpopKey.x && key.y === dpopKey.y,
			)
		) {
			throw new OAuthCustodyError("OAUTH_SESSION_INVALID");
		}
	}

	async encryptSession(
		id: string,
		publisherDid: `did:${string}:${string}`,
		session: StoredSession,
	) {
		return this.#encryption.encrypt(encoder.encode(JSON.stringify(session)), {
			purpose: "oauth-session",
			table: "delegations",
			primaryKey: id,
			ownerDid: publisherDid,
		});
	}
}

export function createOAuthStores(
	repository: OAuthCustodyRepository,
	options: OAuthStoreOptions,
): OAuthClientStores {
	if (
		(options.purpose !== "console_login" && !isDid(options.expectedDid)) ||
		(options.expectedDid !== null && !isDid(options.expectedDid))
	) {
		throw new OAuthCustodyError("OAUTH_IDENTITY_MISMATCH");
	}
	const states: Store<string, StoredState> = {
		get: (key) => repository.getTransaction(key, options),
		set: (key, value) => repository.putTransaction(key, value, options),
		delete: (key) => repository.deleteTransaction(key, options),
		clear: () => repository.clearTransactions(options),
	};
	if (options.purpose !== "release_delegation") {
		const memory = new MemoryStore<`did:${string}:${string}`, StoredSession>();
		const sessions: Store<`did:${string}:${string}`, StoredSession> = {
			get: (did) => memory.get(did),
			set: (did, session) => {
				repository.validateIdentitySession(did, options.expectedDid, session);
				memory.set(did, session);
			},
			delete: (did) => memory.delete(did),
			clear: () => memory.clear(),
		};
		return { states, sessions };
	}
	const sessions: Store<`did:${string}:${string}`, StoredSession> = {
		get: (did) => repository.getDelegationSession(did),
		set: (did, session) => repository.putDelegation(did, session).then(() => undefined),
		delete: (did) => repository.revokeDelegation(did),
		clear: () => Promise.reject(new OAuthCustodyError("OAUTH_DELEGATION_CAS_REQUIRED")),
	};
	return { states, sessions };
}
