/**
 * Environment-variable credential store.
 *
 * Read-only. Reads a single publisher session from environment variables for
 * use in CI:
 *
 *   - `EMDASH_PUBLISHER_DID`        — the publisher DID (required).
 *   - `EMDASH_PUBLISHER_HANDLE`     — the publisher handle (required).
 *   - `EMDASH_PUBLISHER_PDS`        — the PDS URL (required).
 *   - `EMDASH_PUBLISHER_SESSION`    — opaque session blob, JSON-encoded; the
 *     OAuth client manages this. The shape is the OAuth library's
 *     `StoredSession` type, persisted by the publisher's interactive login on
 *     a developer machine and copied into CI as a single secret.
 *
 * The session blob is opaque to this layer -- it's plumbed through to the
 * OAuth client when the publishing client constructs one. We only need the
 * three identity fields here so the rest of the system can answer "who is
 * authenticated?" without parsing the blob.
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
		return { did, handle, pds, updatedAt: Date.now() };
	}
}
