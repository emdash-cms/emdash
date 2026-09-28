/**
 * Media-usage generation GC.
 *
 * Every save writes a fresh generation of `_emdash_media_usage` rows and
 * leaves the superseded generation behind; reads join on
 * `current_generation`, so non-current rows are dead weight. This sweep
 * composes the repository GC methods behind a shared cutoff and batch limit,
 * and is called from `runSystemCleanup` on every scheduler tick.
 */

import type { Kysely } from "kysely";

import { MediaUsageRepository } from "../../database/repositories/media-usage.js";
import type { Database } from "../../database/types.js";

/**
 * Only rows older than this are collected. Guarded writers insert occurrence
 * rows before winning the source CAS, so the window must exceed any plausible
 * in-flight write; mirrors the pending-upload abandonment window.
 */
const GC_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Per-tick cap on rows considered by each GC method, so a large backlog is
 * amortized across ticks instead of one oversized batch (D1 bind limits).
 */
const GC_BATCH_LIMIT = 500;

export interface MediaUsageCleanupResult {
	staleGenerations: number;
	abandonedGenerations: number;
	orphanOccurrences: number;
}

/**
 * Delete media-usage occurrence rows that can no longer be read: superseded
 * generations, generations abandoned by losing CAS writers, and occurrences
 * whose source row is gone.
 */
export async function cleanupMediaUsageGenerations(
	db: Kysely<Database>,
): Promise<MediaUsageCleanupResult> {
	const cutoff = new Date(Date.now() - GC_MAX_AGE_MS).toISOString();
	const repo = new MediaUsageRepository(db);
	return {
		staleGenerations: await repo.deleteStaleGenerationsOlderThan(cutoff, GC_BATCH_LIMIT),
		abandonedGenerations: await repo.deleteAbandonedGenerationsOlderThan(cutoff, GC_BATCH_LIMIT),
		orphanOccurrences: await repo.deleteOrphanOccurrencesOlderThan(cutoff, GC_BATCH_LIMIT),
	};
}
