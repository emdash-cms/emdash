import type { ActorResolver } from "@atcute/identity-resolver";
import {
	CompositeDidDocumentResolver,
	CompositeHandleResolver,
	DohJsonHandleResolver,
	LocalActorResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver,
	WellKnownHandleResolver,
} from "@atcute/identity-resolver";
import {
	MemoryStore,
	OAuthClient,
	type AuthorizationResult,
	type AuthorizeTarget,
	type OAuthClientStores,
	type OAuthSession,
	type RestoreOptions,
	type Store,
	type StoredSession,
	type StoredState,
} from "@atcute/oauth-node-client";
import { env } from "cloudflare:workers";

import type { ApproverDurableObject } from "../approver-do/approver-do.js";
import type { OAuthConfiguration } from "../config.js";
import {
	EncryptionError,
	type EncryptionContext,
	type EnvelopeEncryption,
} from "../crypto/encryption.js";
import type {
	DelegationReauthorizationReason,
	DelegationRefreshLease,
	PublisherDurableObject,
	StoredDelegation,
} from "../publisher-do/publisher-do.js";
import type { StoredOAuthTransaction } from "./state-do.js";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const BASE64_PADDING_PATTERN = /=+$/;
const MAX_STATE_LIFETIME_MS = 11 * 60_000;
const REFRESH_LEASE_MS = 60_000;
const REFRESH_LOCK_TIMEOUT_MS = REFRESH_LEASE_MS + 5_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Did = `did:${string}:${string}`;

export type PublisherOAuthPurpose =
	| "publisher_identity"
	| "approver_identity"
	| "release_delegation";

export interface PublisherOAuthFlowOptions {
	purpose: PublisherOAuthPurpose;
	expectedDid: Did;
	redirectTarget: string;
}

type PublisherShardOAuthFlowOptions = Omit<PublisherOAuthFlowOptions, "purpose"> & {
	purpose: "publisher_identity" | "release_delegation";
};

type ApproverOAuthFlowOptions = Omit<PublisherOAuthFlowOptions, "purpose"> & {
	purpose: "approver_identity";
};

export interface PublisherOAuthUserState {
	purpose: PublisherOAuthPurpose;
	expectedDid: Did;
	redirectTarget: string;
}

export type OAuthCustodyErrorCode =
	| "OAUTH_CLIENT_KEY_UNAVAILABLE"
	| "OAUTH_CLIENT_AUTH_INVALID"
	| "OAUTH_SCOPE_INVALID"
	| "OAUTH_IDENTITY_MISMATCH"
	| "OAUTH_STATE_INVALID"
	| "OAUTH_SESSION_INVALID"
	| "OAUTH_REDIRECT_INVALID"
	| "OAUTH_DELEGATION_CAS_REQUIRED"
	| "OAUTH_DELEGATION_UNAVAILABLE"
	| "OAUTH_REFRESH_LOCK_TIMEOUT";

const ERROR_MESSAGES: Record<OAuthCustodyErrorCode, string> = {
	OAUTH_CLIENT_KEY_UNAVAILABLE: "OAuth client key is unavailable",
	OAUTH_CLIENT_AUTH_INVALID: "OAuth client authentication is invalid",
	OAUTH_SCOPE_INVALID: "OAuth scope is invalid",
	OAUTH_IDENTITY_MISMATCH: "OAuth identity does not match",
	OAUTH_STATE_INVALID: "OAuth state is invalid",
	OAUTH_SESSION_INVALID: "OAuth session is invalid",
	OAUTH_REDIRECT_INVALID: "OAuth redirect is invalid",
	OAUTH_DELEGATION_CAS_REQUIRED: "OAuth delegation requires a compare-and-set update",
	OAUTH_DELEGATION_UNAVAILABLE: "OAuth delegation is unavailable",
	OAUTH_REFRESH_LOCK_TIMEOUT: "OAuth refresh lock timed out",
};

export class OAuthCustodyError extends Error {
	readonly code: OAuthCustodyErrorCode;
	readonly reauthorizationRequired: boolean;

	constructor(code: OAuthCustodyErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = "OAuthCustodyError";
		this.code = code;
		this.reauthorizationRequired =
			code === "OAUTH_CLIENT_KEY_UNAVAILABLE" || code === "OAUTH_DELEGATION_UNAVAILABLE";
	}
}

interface ActiveRefreshLease extends DelegationRefreshLease {
	publisherDid: Did;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDid(value: unknown): value is Did {
	return typeof value === "string" && value.length <= 2048 && DID_PATTERN.test(value);
}

function validBoundedString(value: unknown, maxLength: number, minLength = 1): value is string {
	return typeof value === "string" && value.length >= minLength && value.length <= maxLength;
}

function isBase64Url(value: unknown, byteLength?: number): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		!BASE64URL_PATTERN.test(value) ||
		value.length % 4 === 1
	) {
		return false;
	}
	if (byteLength === undefined) return true;
	try {
		const binary = atob(
			value
				.replaceAll("-", "+")
				.replaceAll("_", "/")
				.padEnd(value.length + ((4 - (value.length % 4)) % 4), "="),
		);
		return binary.length === byteLength;
	} catch {
		return false;
	}
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

function getClientKeyId(value: { authMethod: StoredState["authMethod"] }): string {
	if (
		value.authMethod.method !== "private_key_jwt" ||
		typeof value.authMethod.kid !== "string" ||
		value.authMethod.kid.length === 0 ||
		value.authMethod.kid.length > 128
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
		!isBase64Url(value["x"], 32) ||
		!isBase64Url(value["y"], 32) ||
		!isBase64Url(value["d"], 32) ||
		(typeof value["kid"] !== "undefined" && typeof value["kid"] !== "string")
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
		!validBoundedString(parsed["pkceVerifier"], 128, 43) ||
		!validHttpsOrigin(parsed["issuer"]) ||
		typeof parsed["redirectUri"] !== "string" ||
		(typeof parsed["sub"] !== "undefined" && !isDid(parsed["sub"])) ||
		typeof parsed["expiresAt"] !== "number" ||
		!Number.isSafeInteger(parsed["expiresAt"])
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
		!validHttpsOrigin(parsed["tokenSet"]["iss"]) ||
		!isDid(parsed["tokenSet"]["sub"]) ||
		!validHttpsOrigin(parsed["tokenSet"]["aud"]) ||
		!validBoundedString(parsed["tokenSet"]["scope"], 4096) ||
		!validBoundedString(parsed["tokenSet"]["access_token"], 65_536) ||
		(typeof parsed["tokenSet"]["refresh_token"] !== "undefined" &&
			!validBoundedString(parsed["tokenSet"]["refresh_token"], 65_536)) ||
		parsed["tokenSet"]["token_type"] !== "DPoP" ||
		(typeof parsed["tokenSet"]["expires_at"] !== "undefined" &&
			!Number.isSafeInteger(parsed["tokenSet"]["expires_at"]))
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

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(BASE64_PADDING_PATTERN, "");
}

async function hashOpaque(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
	return encodeBase64Url(new Uint8Array(digest));
}

export function canonicalizeRedirectTarget(value: string, publicOrigin: string): string {
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

function expectedUserState(
	options: PublisherOAuthFlowOptions,
	publicOrigin: string,
): PublisherOAuthUserState {
	return {
		purpose: options.purpose,
		expectedDid: options.expectedDid,
		redirectTarget: canonicalizeRedirectTarget(options.redirectTarget, publicOrigin),
	};
}

function parseUserState(
	value: unknown,
	options: PublisherOAuthFlowOptions,
	publicOrigin: string,
): PublisherOAuthUserState {
	const expected = expectedUserState(options, publicOrigin);
	if (
		!isRecord(value) ||
		Object.keys(value).length !== 3 ||
		value["purpose"] !== expected.purpose ||
		value["expectedDid"] !== expected.expectedDid ||
		value["redirectTarget"] !== expected.redirectTarget
	) {
		throw new OAuthCustodyError("OAUTH_STATE_INVALID");
	}
	return expected;
}

function transactionEncryptionPurpose(purpose: PublisherOAuthPurpose) {
	if (purpose === "release_delegation") return "oauth-delegation-transaction" as const;
	if (purpose === "approver_identity") return "oauth-approver-transaction" as const;
	return "oauth-console-transaction" as const;
}

interface PutDurableOAuthStateInput {
	stateHash: string;
	encryptedState: string;
	encryptionKeyVersion: number;
	encryptionPurpose: ReturnType<typeof transactionEncryptionPurpose>;
	clientKeyId: string;
	redirectTarget: string;
	expiresAt: number;
}

interface DurableOAuthStateBackend {
	objectClass: "OAuthStateDurableObject";
	table: "oauth_state";
	put(input: PutDurableOAuthStateInput): Promise<{ ok: boolean }>;
	consume(stateHash: string): Promise<StoredOAuthTransaction | null>;
}

function oauthStateBackend(options: PublisherOAuthFlowOptions): DurableOAuthStateBackend {
	return {
		objectClass: "OAuthStateDurableObject",
		table: "oauth_state",
		put: (input) =>
			env.OAUTH_STATE_DO.getByName(input.stateHash).put({
				...input,
				ownerDid: options.expectedDid,
				purpose: options.purpose,
			}),
		consume: (stateHash) =>
			env.OAUTH_STATE_DO.getByName(stateHash).consume({
				stateHash,
				ownerDid: options.expectedDid,
				purpose: options.purpose,
			}),
	};
}

class DurableOAuthStateStore implements Store<string, StoredState> {
	readonly #backend: DurableOAuthStateBackend;
	readonly #encryption: EnvelopeEncryption;
	readonly #oauth: OAuthConfiguration;
	readonly #options: PublisherOAuthFlowOptions;

	constructor(
		backend: DurableOAuthStateBackend,
		encryption: EnvelopeEncryption,
		oauth: OAuthConfiguration,
		options: PublisherOAuthFlowOptions,
	) {
		this.#backend = backend;
		this.#encryption = encryption;
		this.#oauth = oauth;
		this.#options = options;
	}

	async set(rawState: string, state: StoredState): Promise<void> {
		if (!isBase64Url(rawState) || rawState.length > 128) {
			throw new OAuthCustodyError("OAUTH_STATE_INVALID");
		}
		const now = Date.now();
		const keyId = getClientKeyId(state);
		assertClientKeyAvailable(this.#oauth, keyId);
		assertSeparateDpopKey(this.#oauth, state.dpopKey);
		if (
			state.sub !== this.#options.expectedDid ||
			!validBoundedString(state.pkceVerifier, 128, 43) ||
			!validHttpsOrigin(state.issuer) ||
			!this.#oauth.clientMetadata.redirect_uris.includes(state.redirectUri) ||
			!Number.isSafeInteger(state.expiresAt) ||
			state.expiresAt <= now ||
			state.expiresAt > now + MAX_STATE_LIFETIME_MS
		) {
			throw new OAuthCustodyError("OAUTH_STATE_INVALID");
		}
		const userState = parseUserState(
			state.userState,
			this.#options,
			this.#oauth.clientMetadata.client_uri,
		);
		const stateHash = await hashOpaque(rawState);
		const encrypted = await this.#encryption.encrypt(
			encoder.encode(JSON.stringify({ ...state, userState })),
			this.#encryptionContext(stateHash),
		);
		const result = await this.#backend.put({
			stateHash,
			encryptedState: encrypted.envelope,
			encryptionKeyVersion: encrypted.keyVersion,
			encryptionPurpose: transactionEncryptionPurpose(this.#options.purpose),
			clientKeyId: keyId,
			redirectTarget: userState.redirectTarget,
			expiresAt: state.expiresAt,
		});
		if (!result.ok) throw new OAuthCustodyError("OAUTH_STATE_INVALID");
	}

	async get(rawState: string): Promise<StoredState | undefined> {
		if (!isBase64Url(rawState) || rawState.length > 128) return undefined;
		const stateHash = await hashOpaque(rawState);
		const stored = await this.#backend.consume(stateHash);
		if (!stored) return undefined;
		assertClientKeyAvailable(this.#oauth, stored.clientKeyId);
		const plaintext = await this.#encryption.decrypt(
			stored.encryptedState,
			this.#encryptionContext(stateHash),
		);
		const state = parseStoredState(decoder.decode(plaintext));
		if (
			getClientKeyId(state) !== stored.clientKeyId ||
			state.sub !== this.#options.expectedDid ||
			state.expiresAt !== stored.expiresAt ||
			!this.#oauth.clientMetadata.redirect_uris.includes(state.redirectUri)
		) {
			throw new OAuthCustodyError("OAUTH_STATE_INVALID");
		}
		return {
			...state,
			userState: parseUserState(
				state.userState,
				this.#options,
				this.#oauth.clientMetadata.client_uri,
			),
		};
	}

	async delete(rawState: string): Promise<void> {
		if (!isBase64Url(rawState) || rawState.length > 128) return;
		await this.#backend.consume(await hashOpaque(rawState));
	}

	clear(): Promise<void> {
		return Promise.reject(new OAuthCustodyError("OAUTH_STATE_INVALID"));
	}

	#encryptionContext(stateHash: string): EncryptionContext {
		return {
			purpose: transactionEncryptionPurpose(this.#options.purpose),
			objectClass: this.#backend.objectClass,
			table: this.#backend.table,
			primaryKey: stateHash,
			ownerDid: this.#options.expectedDid,
		};
	}
}

class PublisherOAuthSessionStore implements Store<Did, StoredSession> {
	readonly #stub: DurableObjectStub<PublisherDurableObject>;
	readonly #encryption: EnvelopeEncryption;
	readonly #oauth: OAuthConfiguration;
	readonly #options: PublisherShardOAuthFlowOptions;
	readonly #identitySessions: Store<Did, StoredSession> = new MemoryStore<Did, StoredSession>();
	#activeLease: ActiveRefreshLease | null = null;
	#sessionVersion: number | null = null;

	constructor(
		stub: DurableObjectStub<PublisherDurableObject>,
		encryption: EnvelopeEncryption,
		oauth: OAuthConfiguration,
		options: PublisherShardOAuthFlowOptions,
	) {
		this.#stub = stub;
		this.#encryption = encryption;
		this.#oauth = oauth;
		this.#options = options;
	}

	async get(did: Did): Promise<StoredSession | undefined> {
		this.#assertDid(did);
		if (this.#options.purpose === "publisher_identity") {
			return this.#identitySessions.get(did);
		}
		const stored = this.#activeLease
			? await this.#stub.getDelegationForRefresh(
					this.#activeLease.publisherDid,
					this.#activeLease.generation,
					this.#activeLease.token,
				)
			: await this.#stub.getDelegation(did);
		if (!stored || stored.status !== "active" || stored.encryptedSession.length === 0) {
			this.#sessionVersion = null;
			return undefined;
		}
		try {
			const session = await this.#decryptSession(stored, did);
			this.#sessionVersion = stored.stateVersion;
			return session;
		} catch (error) {
			await this.#requireReauthorization(did, stored, error);
			throw error;
		}
	}

	async set(did: Did, session: StoredSession): Promise<void> {
		this.#assertDid(did);
		this.#validateSession(did, session);
		if (this.#options.purpose === "publisher_identity") {
			await this.#identitySessions.set(did, session);
			return;
		}
		const encrypted = await this.#encryptSession(did, session);
		const fields = {
			clientKeyId: getClientKeyId(session),
			encryptedSession: encrypted.envelope,
			encryptionKeyVersion: encrypted.keyVersion,
			issuer: session.tokenSet.iss,
			pdsUrl: session.tokenSet.aud,
			expiresAt: session.tokenSet.expires_at ?? null,
			refreshBefore: session.tokenSet.expires_at ?? null,
		};
		if (this.#activeLease) {
			const result = await this.#stub.completeDelegationRefresh({
				publisherDid: did,
				generation: this.#activeLease.generation,
				token: this.#activeLease.token,
				expectedVersion: this.#activeLease.expectedVersion,
				...fields,
			});
			if (!result.ok) throw new OAuthCustodyError("OAUTH_DELEGATION_CAS_REQUIRED");
			this.#sessionVersion = result.delegation.stateVersion;
			return;
		}
		const existing = await this.#stub.getDelegation(did);
		if (existing?.status === "active") {
			throw new OAuthCustodyError("OAUTH_DELEGATION_CAS_REQUIRED");
		}
		const result = await this.#stub.putDelegation({
			publisherDid: did,
			releaseNsid: this.#oauth.releaseNsid,
			scope: this.#oauth.releaseScope,
			...fields,
			expectedVersion: existing?.stateVersion ?? null,
		});
		if (!result.ok) throw new OAuthCustodyError("OAUTH_DELEGATION_CAS_REQUIRED");
		this.#sessionVersion = result.delegation.stateVersion;
	}

	async delete(did: Did): Promise<void> {
		this.#assertDid(did);
		if (this.#options.purpose === "publisher_identity") {
			await this.#identitySessions.delete(did);
			return;
		}
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const existing = await this.#stub.getDelegation(did);
			if (!existing || existing.status === "revoked") {
				this.#sessionVersion = null;
				return;
			}
			const result = await this.#stub.revokeDelegation(did, existing.stateVersion);
			if (result.ok) {
				this.#sessionVersion = null;
				return;
			}
		}
		throw new OAuthCustodyError("OAUTH_DELEGATION_CAS_REQUIRED");
	}

	async clear(): Promise<void> {
		if (this.#options.purpose === "publisher_identity") {
			await this.#identitySessions.clear();
			return;
		}
		throw new OAuthCustodyError("OAUTH_DELEGATION_CAS_REQUIRED");
	}

	async requestLock<T>(name: string, callback: () => Promise<T>): Promise<T> {
		if (this.#options.purpose !== "release_delegation") return callback();
		if (name !== `oauth-session-${this.#options.expectedDid}` || this.#activeLease) {
			throw new OAuthCustodyError("OAUTH_SESSION_INVALID");
		}
		const deadline = Date.now() + REFRESH_LOCK_TIMEOUT_MS;
		let lease: ActiveRefreshLease | null = null;
		while (lease === null) {
			const result = await this.#stub.beginDelegationRefresh(
				this.#options.expectedDid,
				REFRESH_LEASE_MS,
			);
			if (result.ok) {
				lease = { ...result.lease, publisherDid: this.#options.expectedDid };
				break;
			}
			if (result.code === "DELEGATION_UNAVAILABLE") {
				throw new OAuthCustodyError("OAUTH_DELEGATION_UNAVAILABLE");
			}
			const now = Date.now();
			if (now >= deadline) throw new OAuthCustodyError("OAUTH_REFRESH_LOCK_TIMEOUT");
			await new Promise<void>((resolve) => {
				setTimeout(resolve, Math.min(250, Math.max(10, result.retryAt - now)));
			});
		}
		this.#activeLease = lease;
		try {
			return await callback();
		} finally {
			this.#activeLease = null;
			await this.#stub.releaseDelegationRefresh(lease.publisherDid, lease.generation, lease.token);
		}
	}

	sessionVersion(did: string): number {
		this.#assertDid(did);
		if (this.#options.purpose !== "release_delegation" || this.#sessionVersion === null) {
			throw new OAuthCustodyError("OAUTH_DELEGATION_UNAVAILABLE");
		}
		return this.#sessionVersion;
	}

	#assertDid(did: string): asserts did is Did {
		if (did !== this.#options.expectedDid || !isDid(did)) {
			throw new OAuthCustodyError("OAUTH_IDENTITY_MISMATCH");
		}
	}

	#validateSession(did: Did, session: StoredSession): void {
		const expectedScope =
			this.#options.purpose === "release_delegation" ? this.#oauth.releaseScope : "atproto";
		assertClientKeyAvailable(this.#oauth, getClientKeyId(session));
		assertDpopKey(session.dpopKey);
		assertSeparateDpopKey(this.#oauth, session.dpopKey);
		if (session.tokenSet.sub !== did) {
			throw new OAuthCustodyError("OAUTH_IDENTITY_MISMATCH");
		}
		if (session.tokenSet.scope !== expectedScope) {
			throw new OAuthCustodyError("OAUTH_SCOPE_INVALID");
		}
		if (
			session.tokenSet.token_type !== "DPoP" ||
			!validHttpsOrigin(session.tokenSet.iss) ||
			!validHttpsOrigin(session.tokenSet.aud) ||
			!validBoundedString(session.tokenSet.access_token, 65_536) ||
			(session.tokenSet.refresh_token !== undefined &&
				!validBoundedString(session.tokenSet.refresh_token, 65_536)) ||
			(session.tokenSet.expires_at !== undefined &&
				!Number.isSafeInteger(session.tokenSet.expires_at)) ||
			(this.#options.purpose === "release_delegation" &&
				(typeof session.tokenSet.refresh_token !== "string" ||
					session.tokenSet.refresh_token.length === 0))
		) {
			throw new OAuthCustodyError("OAUTH_SESSION_INVALID");
		}
	}

	async #encryptSession(did: Did, session: StoredSession) {
		return this.#encryption.encrypt(
			encoder.encode(JSON.stringify(session)),
			this.#sessionEncryptionContext(did),
		);
	}

	async #decryptSession(stored: StoredDelegation, did: Did): Promise<StoredSession> {
		if (
			stored.releaseNsid !== this.#oauth.releaseNsid ||
			stored.scope !== this.#oauth.releaseScope ||
			stored.encryptionKeyVersion === null ||
			stored.issuer === null ||
			stored.pdsUrl === null
		) {
			throw new OAuthCustodyError("OAUTH_SESSION_INVALID");
		}
		assertClientKeyAvailable(this.#oauth, stored.clientKeyId);
		const plaintext = await this.#encryption.decrypt(
			stored.encryptedSession,
			this.#sessionEncryptionContext(did),
		);
		const session = parseStoredSession(decoder.decode(plaintext));
		this.#validateSession(did, session);
		if (
			getClientKeyId(session) !== stored.clientKeyId ||
			session.tokenSet.iss !== stored.issuer ||
			session.tokenSet.aud !== stored.pdsUrl ||
			(session.tokenSet.expires_at ?? null) !== stored.expiresAt
		) {
			throw new OAuthCustodyError("OAUTH_SESSION_INVALID");
		}
		return session;
	}

	async #requireReauthorization(did: Did, stored: StoredDelegation, error: unknown): Promise<void> {
		this.#sessionVersion = null;
		let reason: DelegationReauthorizationReason = "OAUTH_SESSION_INVALID";
		if (error instanceof OAuthCustodyError && error.code === "OAUTH_CLIENT_KEY_UNAVAILABLE") {
			reason = "OAUTH_CLIENT_KEY_UNAVAILABLE";
		} else if (error instanceof EncryptionError && error.code === "ENCRYPTION_KEY_UNAVAILABLE") {
			reason = "ENCRYPTION_KEY_UNAVAILABLE";
		}
		await this.#stub.requireDelegationReauthorization(did, stored.stateVersion, reason);
	}

	#sessionEncryptionContext(did: Did): EncryptionContext {
		return {
			purpose: "oauth-session",
			objectClass: "PublisherDurableObject",
			table: "delegation",
			primaryKey: "1",
			ownerDid: did,
		};
	}
}

function assertClientKeyAvailable(oauth: OAuthConfiguration, keyId: string): void {
	if (!oauth.hasAssertionKey(keyId)) {
		throw new OAuthCustodyError("OAUTH_CLIENT_KEY_UNAVAILABLE");
	}
}

function assertSeparateDpopKey(oauth: OAuthConfiguration, dpopKey: StoredSession["dpopKey"]): void {
	if (
		dpopKey.kty === "EC" &&
		oauth.assertionKeys.some(
			(key) => key.kty === "EC" && key.x === dpopKey.x && key.y === dpopKey.y,
		)
	) {
		throw new OAuthCustodyError("OAUTH_SESSION_INVALID");
	}
}

export interface PublisherOAuthStores {
	stores: OAuthClientStores;
	requestLock?: <T>(name: string, callback: () => Promise<T>) => Promise<T>;
	sessionVersion?: (did: string) => number;
	userState: PublisherOAuthUserState;
}

export function createPublisherOAuthStores(
	namespace: DurableObjectNamespace<PublisherDurableObject>,
	encryption: EnvelopeEncryption,
	oauth: OAuthConfiguration,
	options: PublisherShardOAuthFlowOptions,
): PublisherOAuthStores {
	if (!isDid(options.expectedDid)) {
		throw new OAuthCustodyError("OAUTH_IDENTITY_MISMATCH");
	}
	const normalizedOptions = {
		...options,
		redirectTarget: canonicalizeRedirectTarget(
			options.redirectTarget,
			oauth.clientMetadata.client_uri,
		),
	};
	const stub = namespace.getByName(options.expectedDid);
	const states = new DurableOAuthStateStore(
		oauthStateBackend(normalizedOptions),
		encryption,
		oauth,
		normalizedOptions,
	);
	const sessions = new PublisherOAuthSessionStore(stub, encryption, oauth, normalizedOptions);
	return {
		stores: { states, sessions },
		...(options.purpose === "release_delegation"
			? {
					requestLock: sessions.requestLock.bind(sessions),
					sessionVersion: sessions.sessionVersion.bind(sessions),
				}
			: {}),
		userState: expectedUserState(normalizedOptions, oauth.clientMetadata.client_uri),
	};
}

export function createWorkerActorResolver(fetchThis: typeof fetch = fetch): ActorResolver {
	return new LocalActorResolver({
		handleResolver: new CompositeHandleResolver({
			methods: {
				dns: new DohJsonHandleResolver({
					dohUrl: "https://cloudflare-dns.com/dns-query",
					fetch: fetchThis,
				}),
				http: new WellKnownHandleResolver({ fetch: fetchThis }),
			},
		}),
		didDocumentResolver: new CompositeDidDocumentResolver({
			methods: {
				plc: new PlcDidDocumentResolver({ fetch: fetchThis }),
				web: new WebDidDocumentResolver({ fetch: fetchThis }),
			},
		}),
	});
}

export interface CreatePublisherOAuthClientOptions {
	namespace: DurableObjectNamespace<PublisherDurableObject>;
	encryption: EnvelopeEncryption;
	oauth: OAuthConfiguration;
	flow: PublisherShardOAuthFlowOptions;
	actorResolver?: ActorResolver;
	fetch?: typeof globalThis.fetch;
}

export interface CreateApproverOAuthClientOptions {
	namespace: DurableObjectNamespace<ApproverDurableObject>;
	encryption: EnvelopeEncryption;
	oauth: OAuthConfiguration;
	flow: ApproverOAuthFlowOptions;
	actorResolver?: ActorResolver;
	fetch?: typeof globalThis.fetch;
}

export class PublisherOAuthClient {
	readonly #client: OAuthClient;
	readonly #oauth: OAuthConfiguration;
	readonly #flow: PublisherOAuthFlowOptions;
	readonly #sessionVersion: ((did: string) => number) | undefined;
	readonly userState: PublisherOAuthUserState;

	constructor(
		client: OAuthClient,
		oauth: OAuthConfiguration,
		flow: PublisherOAuthFlowOptions,
		userState: PublisherOAuthUserState,
		sessionVersion?: (did: string) => number,
	) {
		this.#client = client;
		this.#oauth = oauth;
		this.#flow = flow;
		this.#sessionVersion = sessionVersion;
		this.userState = userState;
	}

	get metadata(): OAuthClient["metadata"] {
		return this.#client.metadata;
	}

	get jwks(): OAuthClient["jwks"] {
		return this.#client.jwks;
	}

	authorize(
		target: AuthorizeTarget,
		options: { signal?: AbortSignal } = {},
	): Promise<AuthorizationResult> {
		const scope =
			this.#flow.purpose === "release_delegation" ? this.#oauth.releaseScope : "atproto";
		return this.#client.authorize({
			target,
			scope,
			state: this.userState,
			redirectUri: this.#oauth.clientMetadata.redirect_uris[0],
			...options,
		});
	}

	async callback(params: URLSearchParams): Promise<{
		session: OAuthSession;
		state: PublisherOAuthUserState;
	}> {
		const result = await this.#client.callback(params, {
			redirectUri: this.#oauth.clientMetadata.redirect_uris[0],
		});
		if (result.session.sub !== this.#flow.expectedDid) {
			throw new OAuthCustodyError("OAUTH_IDENTITY_MISMATCH");
		}
		return {
			session: result.session,
			state: parseUserState(result.state, this.#flow, this.#oauth.clientMetadata.client_uri),
		};
	}

	restore(options?: RestoreOptions): Promise<OAuthSession> {
		if (this.#flow.purpose !== "release_delegation") {
			return Promise.reject(new OAuthCustodyError("OAUTH_DELEGATION_UNAVAILABLE"));
		}
		return this.#client.restore(this.#flow.expectedDid, options);
	}

	async restoreForPublication(options?: RestoreOptions): Promise<{
		session: OAuthSession;
		delegationVersion: number;
	}> {
		if (this.#flow.purpose !== "release_delegation" || !this.#sessionVersion) {
			throw new OAuthCustodyError("OAUTH_DELEGATION_UNAVAILABLE");
		}
		const session = await this.#client.restore(this.#flow.expectedDid, options);
		return {
			session,
			delegationVersion: this.#sessionVersion(this.#flow.expectedDid),
		};
	}

	revoke(): Promise<void> {
		return this.#client.revoke(this.#flow.expectedDid);
	}
}

export function createPublisherOAuthClient(
	options: CreatePublisherOAuthClientOptions,
): PublisherOAuthClient {
	const custody = createPublisherOAuthStores(
		options.namespace,
		options.encryption,
		options.oauth,
		options.flow,
	);
	const fetchThis = options.fetch ?? globalThis.fetch;
	const client = new OAuthClient({
		metadata: options.oauth.clientMetadata,
		keyset: options.oauth.keyset,
		stores: custody.stores,
		actorResolver: options.actorResolver ?? createWorkerActorResolver(fetchThis),
		...(custody.requestLock ? { requestLock: custody.requestLock } : {}),
		fetch: fetchThis,
	});
	return new PublisherOAuthClient(
		client,
		options.oauth,
		options.flow,
		custody.userState,
		custody.sessionVersion,
	);
}

export function createApproverOAuthClient(
	options: CreateApproverOAuthClientOptions,
): PublisherOAuthClient {
	if (!isDid(options.flow.expectedDid)) {
		throw new OAuthCustodyError("OAUTH_IDENTITY_MISMATCH");
	}
	const flow = {
		...options.flow,
		redirectTarget: canonicalizeRedirectTarget(
			options.flow.redirectTarget,
			options.oauth.clientMetadata.client_uri,
		),
	};
	const states = new DurableOAuthStateStore(
		oauthStateBackend(flow),
		options.encryption,
		options.oauth,
		flow,
	);
	const sessions = new MemoryStore<Did, StoredSession>();
	const fetchThis = options.fetch ?? globalThis.fetch;
	const client = new OAuthClient({
		metadata: options.oauth.clientMetadata,
		keyset: options.oauth.keyset,
		stores: { states, sessions },
		actorResolver: options.actorResolver ?? createWorkerActorResolver(fetchThis),
		fetch: fetchThis,
	});
	return new PublisherOAuthClient(
		client,
		options.oauth,
		flow,
		expectedUserState(flow, options.oauth.clientMetadata.client_uri),
	);
}
