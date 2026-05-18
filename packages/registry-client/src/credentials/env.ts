/**
 * Environment-variable credential store.
 *
 * Read-only. Reads the publisher's identity (the three fields needed to
 * answer "who is authenticated?") from environment variables for use in
 * CI:
 *
 *   - `EMDASH_PUBLISHER_DID`        — the publisher DID (required).
 *   - `EMDASH_PUBLISHER_HANDLE`     — the publisher handle (required).
 *   - `EMDASH_PUBLISHER_PDS`        — the PDS URL (required).
 *
 * NOTE: this store does NOT carry the OAuth session blob (refresh tokens,
 * DPoP keys, PAR state). Those are managed by the OAuth client and keyed
 * by DID via its own backing store. Until that backing store has an
 * env-var implementation, automated `publish` from CI requires the OAuth
 * library's session files to be present on disk too. Plan to add an
 * env-var-backed OAuth session store before promoting CI publish out of
 * "experimental".
 *
 * This store throws `ReadOnlyCredentialStoreError` from any mutating method.
 * CI workflows that try to log in interactively are misconfigured by
 * construction; we want a loud failure rather than silently writing
 * credentials onto the runner's filesystem.
 */

import { isDid, isHandle } from "@atcute/lexicons/syntax";

import {
	type CredentialStore,
	type Did,
	type PublisherSession,
	ReadOnlyCredentialStoreError,
} from "./types.js";

export interface EnvCredentialStoreOptions {
	/**
	 * Override the env-var source. Defaults to `process.env`. Mainly useful for
	 * tests; production callers should leave it alone.
	 */
	env?: Record<string, string | undefined>;
}

const ENV_DID = "EMDASH_PUBLISHER_DID";
const ENV_HANDLE = "EMDASH_PUBLISHER_HANDLE";
const ENV_PDS = "EMDASH_PUBLISHER_PDS";

export class EnvCredentialStore implements CredentialStore {
	readonly #env: Record<string, string | undefined>;
	/**
	 * Stamped once at construction time so successive reads return the same
	 * `updatedAt` -- otherwise `current()` and `get(did)` would disagree about
	 * timestamps that were "snapshotted at the same moment", and any caller
	 * caching by reference equality would see a fresh object on every read.
	 */
	readonly #createdAt = Date.now();

	constructor(options: EnvCredentialStoreOptions = {}) {
		this.#env = options.env ?? (process.env as Record<string, string | undefined>);
	}

	async current(): Promise<PublisherSession | null> {
		return this.#read();
	}

	async get(did: Did): Promise<PublisherSession | null> {
		const session = this.#read();
		return session && session.did === did ? session : null;
	}

	async list(): Promise<PublisherSession[]> {
		const session = this.#read();
		return session ? [session] : [];
	}

	async put(): Promise<void> {
		throw new ReadOnlyCredentialStoreError(
			"EnvCredentialStore is read-only; CI must provision credentials via env vars, not via login",
		);
	}

	async setCurrent(): Promise<void> {
		throw new ReadOnlyCredentialStoreError(
			"EnvCredentialStore has at most one session; setCurrent is not meaningful",
		);
	}

	async remove(): Promise<void> {
		throw new ReadOnlyCredentialStoreError(
			"EnvCredentialStore is read-only; rotate credentials by updating env vars instead",
		);
	}

	#read(): PublisherSession | null {
		const did = this.#env[ENV_DID];
		const handle = this.#env[ENV_HANDLE];
		const pds = this.#env[ENV_PDS];
		if (!did || !handle || !pds) return null;
		if (!isDid(did)) {
			throw new Error(`${ENV_DID} is not a valid DID; expected the form "did:method:identifier"`);
		}
		if (!isHandle(handle)) {
			throw new Error(
				`${ENV_HANDLE} is not a valid handle; expected a domain-like form, e.g. "alice.example.com"`,
			);
		}
		return { did, handle, pds, updatedAt: this.#createdAt };
	}
}
