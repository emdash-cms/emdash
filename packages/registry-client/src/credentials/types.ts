/**
 * Credential shapes shared between the credential store, the publishing
 * client, and the CLI. These describe what we persist between an interactive
 * `emdash-registry login` and subsequent CLI invocations.
 *
 * The store itself is implementation-defined (filesystem on disk, in-memory
 * for tests, env-vars for CI). All implementations satisfy `CredentialStore`.
 */

import type { Did, Handle } from "@atcute/lexicons";

/**
 * An atproto DID. Re-exported from `@atcute/lexicons` so that values typed as
 * `Did` flow correctly into atcute's typed XRPC calls (which use the same
 * branded template-literal type internally).
 */
export type { Did, Handle };

/**
 * A persisted publisher session. Created at login, refreshed automatically by
 * the OAuth client, and serialised to wherever the underlying `CredentialStore`
 * decides to put it.
 *
 * The fields here are deliberately the minimum needed to resume a session and
 * identify the publisher; the full atproto OAuth state (DPoP keys, refresh
 * tokens, PAR state) is stored separately by the OAuth library and keyed by
 * `did`. We persist enough to (a) reconstruct an OAuth client and (b) display
 * "you are logged in as <handle>" in the CLI.
 */
export interface PublisherSession {
	/** Publisher DID. The trust root for everything the publisher publishes. */
	did: Did;

	/**
	 * Publisher's handle at the time of the last successful resume.
	 * Best-effort and display-only:
	 *   - handles are mutable, so this may go stale; the CLI re-resolves
	 *     before showing it as authoritative.
	 *   - if handle resolution fails at login, this is `null` and the CLI
	 *     renders the DID instead of a fabricated placeholder.
	 *
	 * Typed as a plain string (not the branded `Handle`) so we don't have
	 * to lie about a placeholder value passing handle validation. Callers
	 * doing handle-shaped operations should re-validate via `isHandle`.
	 */
	handle: string | null;

	/**
	 * Atmosphere PDS endpoint. Populated from the OAuth resolution; needed to
	 * route subsequent repo operations.
	 */
	pds: string;

	/**
	 * Time of last successful login or session refresh. Unix milliseconds.
	 * Used for display ("logged in 3 days ago") and as a quick freshness check.
	 */
	updatedAt: number;
}

/**
 * Storage adapter for credentials. Three implementations are provided:
 *   - `FileCredentialStore` — `~/.emdash/credentials.json`, mode 0600.
 *   - `MemoryCredentialStore` — in-memory, for tests.
 *   - `EnvCredentialStore` — read-only, for CI; reads from environment vars.
 *
 * Stores are keyed by DID so that a single user's CLI install can hold sessions
 * for multiple publisher identities (e.g. a personal DID plus a company DID).
 * The "current" DID is stored alongside.
 */
export interface CredentialStore {
	/**
	 * Read the currently-active session, if any. Returns `null` if no
	 * publisher is logged in.
	 */
	current(): Promise<PublisherSession | null>;

	/**
	 * Read a specific publisher's session by DID, regardless of which is
	 * currently active.
	 */
	get(did: Did): Promise<PublisherSession | null>;

	/**
	 * List all stored publisher sessions. Order is implementation-defined; the
	 * CLI's `emdash plugin whoami` should sort for display.
	 */
	list(): Promise<PublisherSession[]>;

	/**
	 * Persist a session. If the store doesn't already have a current DID, the
	 * stored session becomes current.
	 */
	put(session: PublisherSession): Promise<void>;

	/**
	 * Set which DID is currently active. Throws if the DID isn't in the store.
	 */
	setCurrent(did: Did): Promise<void>;

	/**
	 * Remove a session. If it was the current one, no DID is current after
	 * this returns.
	 */
	remove(did: Did): Promise<void>;
}

/**
 * Marker thrown when an env-var-only credential store is used in a context
 * that requires a writable store (e.g. login). Lets the CLI distinguish
 * "user hasn't logged in" from "this environment is read-only".
 */
export class ReadOnlyCredentialStoreError extends Error {
	constructor(message = "credential store is read-only") {
		super(message);
		this.name = "ReadOnlyCredentialStoreError";
	}
}
