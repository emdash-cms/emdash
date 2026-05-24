/**
 * Auth provider storage helper.
 *
 * Gives auth provider routes access to plugin-style storage collections
 * namespaced under `auth:<providerId>`. Reuses the existing `_plugin_storage`
 * table and `PluginStorageRepository` infrastructure.
 */

import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";
import { createStorageAccess } from "../plugins/context.js";
import type { StorageCollection, StorageCollectionConfig } from "../plugins/types.js";

/**
 * Get storage collections for an auth provider.
 *
 * Returns a record of `StorageCollection` instances, one per declared
 * collection in the provider's `storage` config. Data is stored in the
 * shared `_plugin_storage` table under the namespace `auth:<providerId>`.
 *
 * @example
 * ```ts
 * const storage = getAuthProviderStorage(emdash.db, "atproto", {
 *   states: { indexes: [] },
 *   sessions: { indexes: [] },
 * });
 * const session = await storage.sessions.get(sessionId);
 * ```
 */
export function getAuthProviderStorage(
	db: Kysely<Database>,
	providerId: string,
	storageConfig: Record<string, StorageCollectionConfig>,
): Record<string, StorageCollection> {
	return createStorageAccess(db, `auth:${providerId}`, storageConfig);
}
