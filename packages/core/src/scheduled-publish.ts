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
 * Publishes a single content item. Mirrors the relevant subset of
 * `handleContentPublish`'s return shape. Production callers pass
 * `EmDashRuntime.handleContentPublish` so `content:afterPublish` hooks fire
 * (search indexing, webhooks, syndication); the default falls back to the raw
 * handler (no hooks) for callers that have only a `db`.
 */
export type ScheduledPublishFn = (
	collection: string,
	id: string,
	options: { publishedAt?: string; requireScheduledDue?: boolean },
) => Promise<{ success: boolean; error?: { code?: string } }>;

/**
 * Publish every content item whose `scheduled_at` is in the past.
 *
 * Iterates all collections, finds due items (`findReadyToPublish` returns both
 * scheduled drafts and published entries with pending scheduled changes), and
 * publishes each. `publish()` clears `scheduled_at`, so a second sweep is a
 * no-op — safe to run on every tick.
 *
 * Pass `publish` (the runtime's `handleContentPublish`) so publish hooks fire;
 * without it the sweep falls back to the raw DB handler and hooks are skipped.
 *
 * Returns the items it promoted so request-less callers (the Cloudflare
 * `scheduled()` handler) can invalidate edge-cache tags for them.
 */
export async function publishDueContent(
	db: Kysely<Database>,
	publish?: ScheduledPublishFn,
): Promise<PublishedRef[]> {
	const published: PublishedRef[] = [];

	let collections;
	try {
		collections = await new SchemaRegistry(db).listCollections();
	} catch (error) {
		console.error("[scheduled-publish] Failed to list collections:", error);
		return published;
	}

	const repo = new ContentRepository(db);
	const doPublish: ScheduledPublishFn =
		publish ?? ((collection, id, options) => handleContentPublish(db, collection, id, options));

	for (const collection of collections) {
		try {
			const due = await repo.findReadyToPublish(collection.slug);
			for (const item of due) {
				// First publication of a scheduled draft should record the intended
				// scheduled time, not the (later) sweep time. Items already published
				// with pending draft changes keep their original published_at.
				const publishedAt = item.publishedAt == null ? (item.scheduledAt ?? undefined) : undefined;
				const result = await doPublish(collection.slug, item.id, {
					publishedAt,
					requireScheduledDue: true,
				});
				if (result.success) {
					published.push({ collection: collection.slug, id: item.id });
				} else if (result.error?.code === "NOT_DUE") {
					// Unscheduled or rescheduled between selection and publish — the
					// editor changed their mind; skip quietly, not a failure.
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
