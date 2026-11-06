import { DurableObject } from "cloudflare:workers";

const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const MAX_CIPHERTEXT_CHARS = 256 * 1024;
const MAX_STATE_LIFETIME_MS = 11 * 60_000;

export type OAuthTransactionPurpose =
	| "publisher_identity"
	| "approver_identity"
	| "release_delegation";

export interface PutOAuthTransactionInput {
	stateHash: string;
	ownerDid: string;
	purpose: OAuthTransactionPurpose;
	encryptedState: string;
	encryptionKeyVersion: number;
	clientKeyId: string;
	redirectTarget: string;
	expiresAt: number;
	now?: number;
}

export interface StoredOAuthTransaction {
	encryptedState: string;
	encryptionKeyVersion: number;
	clientKeyId: string;
	redirectTarget: string;
	expiresAt: number;
}

export type PutOAuthTransactionResult =
	| { ok: true }
	| { ok: false; code: "OAUTH_TRANSACTION_EXISTS" };

export interface ConsumeOAuthTransactionInput {
	stateHash: string;
	ownerDid: string;
	purpose: OAuthTransactionPurpose;
	now?: number;
}

interface OAuthTransactionRow {
	[key: string]: string | number | ArrayBuffer | null;
	owner_did: string;
	purpose: OAuthTransactionPurpose;
	encrypted_state: string;
	encryption_key_version: number;
	client_key_id: string;
	redirect_target: string;
	expires_at: number;
}

export class OAuthStateError extends Error {
	readonly code = "OAUTH_TRANSACTION_INVALID";

	constructor() {
		super("OAUTH_TRANSACTION_INVALID");
		this.name = "OAuthStateError";
	}
}

function validPurpose(value: unknown): value is OAuthTransactionPurpose {
	return (
		value === "publisher_identity" ||
		value === "approver_identity" ||
		value === "release_delegation"
	);
}

function validRedirectTarget(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 4096 ||
		!value.startsWith("/") ||
		value.startsWith("//") ||
		value.includes("\\")
	) {
		return false;
	}
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return false;
	}
	return true;
}

function validPutInput(input: PutOAuthTransactionInput, now: number): boolean {
	return (
		HASH_PATTERN.test(input.stateHash) &&
		DID_PATTERN.test(input.ownerDid) &&
		validPurpose(input.purpose) &&
		input.encryptedState.length > 0 &&
		input.encryptedState.length <= MAX_CIPHERTEXT_CHARS &&
		Number.isSafeInteger(input.encryptionKeyVersion) &&
		input.encryptionKeyVersion >= 1 &&
		input.clientKeyId.length > 0 &&
		input.clientKeyId.length <= 128 &&
		validRedirectTarget(input.redirectTarget) &&
		Number.isSafeInteger(now) &&
		now >= 0 &&
		Number.isSafeInteger(input.expiresAt) &&
		input.expiresAt > now &&
		input.expiresAt - now <= MAX_STATE_LIFETIME_MS
	);
}

export class OAuthStateDurableObject extends DurableObject<Env> {
	readonly #objectName: string | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#objectName = ctx.id.name;
		void ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS oauth_state (
					state_hash TEXT PRIMARY KEY,
					owner_did TEXT NOT NULL,
					purpose TEXT NOT NULL CHECK (
						purpose IN ('publisher_identity', 'approver_identity', 'release_delegation')
					),
					encrypted_state TEXT NOT NULL,
					encryption_key_version INTEGER NOT NULL CHECK (encryption_key_version >= 1),
					client_key_id TEXT NOT NULL,
					redirect_target TEXT NOT NULL,
					expires_at INTEGER NOT NULL,
					created_at INTEGER NOT NULL
				);
			`);
		});
	}

	async put(input: PutOAuthTransactionInput): Promise<PutOAuthTransactionResult> {
		this.#assertObjectName(input.stateHash);
		const now = input.now ?? Date.now();
		if (!validPutInput(input, now)) throw new OAuthStateError();
		const result = this.ctx.storage.transactionSync(() => {
			const existing = this.ctx.storage.sql
				.exec<{ state_hash: string }>(
					"SELECT state_hash FROM oauth_state WHERE state_hash = ?",
					input.stateHash,
				)
				.toArray()[0];
			if (existing) return { ok: false, code: "OAUTH_TRANSACTION_EXISTS" } as const;
			this.ctx.storage.sql.exec(
				`INSERT INTO oauth_state (
					state_hash, owner_did, purpose, encrypted_state, encryption_key_version,
					client_key_id, redirect_target, expires_at, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				input.stateHash,
				input.ownerDid,
				input.purpose,
				input.encryptedState,
				input.encryptionKeyVersion,
				input.clientKeyId,
				input.redirectTarget,
				input.expiresAt,
				now,
			);
			return { ok: true } as const;
		});
		if (result.ok) await this.ctx.storage.setAlarm(input.expiresAt);
		return result;
	}

	async consume(input: ConsumeOAuthTransactionInput): Promise<StoredOAuthTransaction | null> {
		this.#assertObjectName(input.stateHash);
		const now = input.now ?? Date.now();
		if (
			!HASH_PATTERN.test(input.stateHash) ||
			!DID_PATTERN.test(input.ownerDid) ||
			!validPurpose(input.purpose) ||
			!Number.isSafeInteger(now) ||
			now < 0
		) {
			throw new OAuthStateError();
		}
		const result = this.ctx.storage.transactionSync(() => {
			const row = this.ctx.storage.sql
				.exec<OAuthTransactionRow>(
					`SELECT owner_did, purpose, encrypted_state, encryption_key_version,
					        client_key_id, redirect_target, expires_at
					 FROM oauth_state WHERE state_hash = ?`,
					input.stateHash,
				)
				.toArray()[0];
			if (!row || row.owner_did !== input.ownerDid || row.purpose !== input.purpose) {
				return { consumed: false, value: null } as const;
			}
			this.ctx.storage.sql.exec("DELETE FROM oauth_state WHERE state_hash = ?", input.stateHash);
			if (row.expires_at <= now) return { consumed: true, value: null } as const;
			return {
				consumed: true,
				value: {
					encryptedState: row.encrypted_state,
					encryptionKeyVersion: row.encryption_key_version,
					clientKeyId: row.client_key_id,
					redirectTarget: row.redirect_target,
					expiresAt: row.expires_at,
				},
			} as const;
		});
		if (result.consumed) await this.ctx.storage.deleteAlarm();
		return result.value;
	}

	override async alarm(): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM oauth_state WHERE expires_at <= ?", Date.now());
	}

	#assertObjectName(stateHash: string): void {
		if (!HASH_PATTERN.test(stateHash) || this.#objectName !== stateHash) {
			throw new OAuthStateError();
		}
	}
}
