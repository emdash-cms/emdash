/**
 * Credential storage for the EmDash plugin registry.
 *
 * This module provides three implementations of `CredentialStore` and a small
 * factory that picks the right one based on the runtime environment.
 *
 * Picking the right store:
 *   - In CI, prefer `EnvCredentialStore` (set `EMDASH_PUBLISHER_*` env vars).
 *   - On a developer machine, prefer `FileCredentialStore` (default path:
 *     `~/.emdash/credentials.json`).
 *   - In tests, use `MemoryCredentialStore`.
 *
 * The `defaultCredentialStore()` helper applies that policy: if the env vars
 * are set, it returns the env store; otherwise it falls through to the file
 * store.
 */

import { EnvCredentialStore } from "./env.js";
import { FileCredentialStore } from "./file.js";
import { MemoryCredentialStore } from "./memory.js";
import type { CredentialStore } from "./types.js";

export {
	type CredentialStore,
	type Did,
	type Handle,
	type PublisherSession,
	ReadOnlyCredentialStoreError,
} from "./types.js";

export { EnvCredentialStore } from "./env.js";
export { FileCredentialStore, type FileCredentialStoreOptions } from "./file.js";
export { MemoryCredentialStore } from "./memory.js";

/**
 * Returns the credential store appropriate to the current environment.
 *
 * If `EMDASH_PUBLISHER_DID`, `EMDASH_PUBLISHER_HANDLE`, and
 * `EMDASH_PUBLISHER_PDS` are all set, returns an `EnvCredentialStore`.
 * Otherwise returns a `FileCredentialStore` at the default path.
 *
 * Tests should not use this helper -- they should pass a `MemoryCredentialStore`
 * explicitly. Calling this from a test is a code smell.
 */
export function defaultCredentialStore(
	env: Record<string, string | undefined> = process.env,
): CredentialStore {
	if (
		env["EMDASH_PUBLISHER_DID"] &&
		env["EMDASH_PUBLISHER_HANDLE"] &&
		env["EMDASH_PUBLISHER_PDS"]
	) {
		return new EnvCredentialStore({ env });
	}
	return new FileCredentialStore();
}
