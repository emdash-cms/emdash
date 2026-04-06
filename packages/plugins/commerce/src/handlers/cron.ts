/**
 * Scheduled maintenance (idempotency TTL, future retention jobs).
 */

import type { PluginContext } from "emdash";

import { COMMERCE_LIMITS } from "../kernel/limits.js";
import type { StoredIdempotencyKey } from "../types.js";
import { asCollection } from "./catalog-conflict.js";

/**
 * Delete idempotency records older than {@link COMMERCE_LIMITS.idempotencyRecordTtlMs}
 * (same window used for replay; expired rows are safe to remove).
 */
export async function handleIdempotencyCleanup(ctx: PluginContext): Promise<void> {
	const coll = asCollection<StoredIdempotencyKey>(ctx.storage.idempotencyKeys);
	const cutoffIso = new Date(Date.now() - COMMERCE_LIMITS.idempotencyRecordTtlMs).toISOString();
	let cursor: string | undefined;
	let deleted = 0;

	do {
		const batch = await coll.query({
			where: { createdAt: { lt: cutoffIso } },
			limit: 100,
			cursor,
			orderBy: { createdAt: "asc" },
		});

		const ids = batch.items.map((row) => row.id);
		if (ids.length > 0) {
			deleted += await coll.deleteMany(ids);
		}

		cursor = batch.cursor;
	} while (cursor);

	if (deleted > 0) {
		ctx.log.info("commerce.cron.idempotency_cleanup", { deleted });
	}
}
