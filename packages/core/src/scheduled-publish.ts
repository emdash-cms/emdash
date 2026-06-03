/**
 * Scheduled publishing sweep
 *
 * Promotes content whose scheduled publish time has passed. Driven by the
 * platform scheduler alongside cron ticks and system cleanup — never by a
 * request. On Node the cron scheduler's maintenance pass calls it; on
 * Cloudflare the Worker's `scheduled()` handler does.
 *
 * Like `runSystemCleanup`, each collection sweep is independent and non-fatal:
 * one collection failing must not stop the rest.
 */

import type { Kysely } from "kysely";

import { handleContentPublish } from "./api/handlers/content.js";
import { ContentRepository } from "./database/repositories/content.js";
import type { Database } from "./database/types.js";
import { SchemaRegistry } from "./schema/registry.js";

/** A content item that was promoted to published by a sweep. */
export interface PublishedRef {
	collection: string;
	id: string;
}

/**
 * Publish every content item whose `scheduled_at` is in the past.
 *
 * Iterates all collections, finds due items (`findReadyToPublish` returns both
 * scheduled drafts and published entries with pending scheduled changes), and
 * publishes each. `publish()` clears `scheduled_at`, so a second sweep is a
 * no-op — safe to run on every tick.
 *
 * Returns the items it promoted so request-less callers (the Cloudflare
 * `scheduled()` handler) can invalidate edge-cache tags for them.
 */
export async function publishDueContent(db: Kysely<Database>): Promise<PublishedRef[]> {
	const published: PublishedRef[] = [];

	let collections;
	try {
		collections = await new SchemaRegistry(db).listCollections();
	} catch (error) {
		console.error("[scheduled-publish] Failed to list collections:", error);
		return published;
	}

	const repo = new ContentRepository(db);

	for (const collection of collections) {
		try {
			const due = await repo.findReadyToPublish(collection.slug);
			for (const item of due) {
				const result = await handleContentPublish(db, collection.slug, item.id);
				if (result.success) {
					published.push({ collection: collection.slug, id: item.id });
				} else {
					console.error(
						`[scheduled-publish] Failed to publish ${collection.slug}/${item.id}:`,
						result.error,
					);
				}
			}
		} catch (error) {
			console.error(`[scheduled-publish] Sweep failed for "${collection.slug}":`, error);
		}
	}

	return published;
}
