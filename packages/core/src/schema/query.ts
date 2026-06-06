/**
 * Collection info query for Astro templates.
 *
 * Same pattern as getMenu() / getComments() — uses getDb() for ambient DB access.
 */

import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";
import { getDb } from "../loader.js";
import { requestCached } from "../request-cache.js";
import { SchemaRegistry } from "./registry.js";
import type { Collection } from "./types.js";

/**
 * Get collection metadata by slug.
 *
 * @example
 * ```ts
 * import { getCollectionInfo } from "emdash";
 *
 * const info = await getCollectionInfo("posts");
 * if (info?.commentsEnabled) {
 *   // render comment UI
 * }
 * ```
 */
export async function getCollectionInfo(slug: string): Promise<Collection | null> {
	return requestCached(`collection-info:${slug}`, async () => {
		const db = await getDb();
		return getCollectionInfoWithDb(db, slug);
	});
}

/**
 * Get collection metadata with an explicit db handle.
 *
 * @internal Use `getCollectionInfo()` in templates. This variant is for
 * routes that already have a database handle.
 */
export async function getCollectionInfoWithDb(
	db: Kysely<Database>,
	slug: string,
): Promise<Collection | null> {
	const registry = new SchemaRegistry(db);
	return registry.getCollection(slug);
}
