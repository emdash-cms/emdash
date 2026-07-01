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
 * Default cap on items promoted per collection in a single sweep. Bounds the
 * publish/webhook fan-out of one tick so a large backlog can't exhaust a Worker
 * invocation's CPU/subrequest budget; the remainder drains on later ticks.
 */
export const SCHEDULED_PUBLISH_BATCH_LIMIT = 100;

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

export interface PublishDueContentOptions {
	/**
	 * Publish callback. Production callers pass the runtime's
	 * `handleContentPublish` so `content:afterPublish` hooks fire (search
	 * indexing, webhooks, syndication). Defaults to the raw DB handler (no hooks).
	 */
	publish?: ScheduledPublishFn;
	/**
	 * Invoked after each collection's batch with the items promoted in that
	 * batch. Lets request-less callers (the Cloudflare `scheduled()` handler)
	 * purge edge-cache tags incrementally instead of only after the whole sweep,
	 * so a runtime killed mid-sweep strands at most one batch behind stale cache
	 * rather than everything published so far. Failures are logged, never fatal.
	 */
	onPublished?: (refs: PublishedRef[]) => Promise<void>;
	/**
	 * Maximum items promoted per collection per sweep. Defaults to
	 * `SCHEDULED_PUBLISH_BATCH_LIMIT`. Pass `0` (or a negative) for unbounded.
	 */
	limit?: number;
}

/**
 * Publish every content item whose `scheduled_at` is in the past.
 *
 * Iterates all collections, finds due items (`findReadyToPublish` returns both
 * scheduled drafts and published entries with pending scheduled changes), and
 * publishes each. `publish()` clears `scheduled_at`, so a second sweep is a
 * no-op — safe to run on every tick.
 *
 * Bounded per collection by `limit` (default `SCHEDULED_PUBLISH_BATCH_LIMIT`):
 * a large backlog drains across successive ticks rather than in one unbounded
 * pass. After each collection's batch, `onPublished` (if given) is awaited so
 * cache-tag invalidation happens incrementally, not just at the very end.
 *
 * Returns every item it promoted so request-less callers (the Cloudflare
 * `scheduled()` handler) can also act on the full set.
 */
export async function publishDueContent(
	db: Kysely<Database>,
	options: PublishDueContentOptions = {},
): Promise<PublishedRef[]> {
	const { publish, onPublished, limit = SCHEDULED_PUBLISH_BATCH_LIMIT } = options;
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
		publish ?? ((collection, id, opts) => handleContentPublish(db, collection, id, opts));
	// 0 / negative means unbounded; findReadyToPublish treats that as "no LIMIT".
	const batchLimit = limit > 0 ? limit : undefined;

	for (const collection of collections) {
		try {
			const due = await repo.findReadyToPublish(collection.slug, batchLimit);
			const batch: PublishedRef[] = [];
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
					batch.push({ collection: collection.slug, id: item.id });
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

			if (batch.length > 0) {
				published.push(...batch);
				if (onPublished) {
					// Purge this batch's cache tags before moving to the next
					// collection, so a mid-sweep kill can't strand already-published
					// content behind stale cache.
					try {
						await onPublished(batch);
					} catch (error) {
						console.error(
							`[scheduled-publish] onPublished failed after "${collection.slug}" batch:`,
							error,
						);
					}
				}
			}
		} catch (error) {
			console.error(`[scheduled-publish] Sweep failed for "${collection.slug}":`, error);
		}
	}

	return published;
}
