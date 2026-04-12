/**
 * System cleanup
 *
 * Runs periodic maintenance tasks that prevent unbounded accumulation of
 * expired or stale data. Called from cron scheduler ticks and (for latency-
 * sensitive subsystems) inline during relevant requests.
 *
 * Each subsystem cleanup is independent and non-fatal -- if one fails, the
 * rest still run. Failures are logged but never surface to callers.
 */

import { createKyselyAdapter, type AuthTables } from "@emdash-cms/auth/adapters/kysely";
import { sql, type Kysely } from "kysely";

import { cleanupExpiredChallenges } from "./auth/challenge-store.js";
import { MediaRepository } from "./database/repositories/media.js";
import { RevisionRepository } from "./database/repositories/revision.js";
import type { Database } from "./database/types.js";
import type { Storage } from "./storage/types.js";

/**
 * Result of a system cleanup run.
 * Each field is the number of rows deleted, or -1 if the cleanup failed.
 */
export interface CleanupResult {
	challenges: number;
	expiredTokens: number;
	pendingUploads: number;
	pendingUploadFiles: number;
	revisionsPruned: number;
}

/** Max revisions to keep per entry during periodic pruning */
const REVISION_KEEP_COUNT = 50;

/** Only prune entries that exceed this threshold */
const REVISION_PRUNE_THRESHOLD = REVISION_KEEP_COUNT;

/**
 * Run all system cleanup tasks.
 *
 * Safe to call frequently -- each task is a single DELETE with a WHERE clause,
 * so repeated calls with nothing to clean are cheap (no-op queries).
 *
 * @param db - The database instance
 * @param storage - Optional storage backend for deleting orphaned files.
 *   When omitted, pending upload DB rows are still deleted but the
 *   corresponding files in object storage are not removed.
 */
export async function runSystemCleanup(
	db: Kysely<Database>,
	storage?: Storage,
): Promise<CleanupResult> {
	const result: CleanupResult = {
		challenges: -1,
		expiredTokens: -1,
		pendingUploads: -1,
		pendingUploadFiles: -1,
		revisionsPruned: -1,
	};

	// 1. Passkey challenges (expire after 60s, clean anything past 5 min)
	try {
		result.challenges = await cleanupExpiredChallenges(db);
	} catch (error) {
		console.error("[cleanup] Failed to clean expired challenges:", error);
	}

	// 2. Magic link / invite / signup tokens
	try {
		// `db` includes all core tables; we only need AuthTables for this adapter.
		const authAdapter = createKyselyAdapter(db as Kysely<AuthTables>);
		await authAdapter.deleteExpiredTokens();
		result.expiredTokens = 0; // deleteExpiredTokens returns void
	} catch (error) {
		console.error("[cleanup] Failed to clean expired tokens:", error);
	}

	// 3. Pending media uploads (abandoned after 1 hour)
	//    Delete DB rows first, then remove corresponding files from storage.
	try {
		const mediaRepo = new MediaRepository(db);
		const orphanedKeys = await mediaRepo.cleanupPendingUploads();
		result.pendingUploads = orphanedKeys.length;

		// Delete orphaned files from object storage
		if (storage && orphanedKeys.length > 0) {
			let filesDeleted = 0;
			for (const key of orphanedKeys) {
				try {
					await storage.delete(key);
					filesDeleted++;
				} catch (error) {
					// Log per-file failures but continue -- storage.delete is
					// documented as idempotent, so this is an unexpected error.
					console.error(`[cleanup] Failed to delete storage file ${key}:`, error);
				}
			}
			result.pendingUploadFiles = filesDeleted;
		} else {
			result.pendingUploadFiles = 0;
		}
	} catch (error) {
		console.error("[cleanup] Failed to clean pending uploads:", error);
	}

	// 4. Revision pruning -- trim entries with excessive revision counts
	try {
		result.revisionsPruned = await pruneExcessiveRevisions(db);
	} catch (error) {
		console.error("[cleanup] Failed to prune revisions:", error);
	}

	return result;
}

/**
 * Find entries with more than REVISION_PRUNE_THRESHOLD revisions and prune
 * them down to REVISION_KEEP_COUNT.
 */
async function pruneExcessiveRevisions(db: Kysely<Database>): Promise<number> {
	const entries = await sql<{ collection: string; entry_id: string; cnt: number }>`
		SELECT collection, entry_id, COUNT(*) as cnt
		FROM revisions
		GROUP BY collection, entry_id
		HAVING cnt > ${REVISION_PRUNE_THRESHOLD}
	`.execute(db);

	if (entries.rows.length === 0) return 0;

	const revisionRepo = new RevisionRepository(db);
	let totalPruned = 0;

	for (const row of entries.rows) {
		try {
			const pruned = await revisionRepo.pruneOldRevisions(
				row.collection,
				row.entry_id,
				REVISION_KEEP_COUNT,
			);
			totalPruned += pruned;
		} catch (error) {
			console.error(
				`[cleanup] Failed to prune revisions for ${row.collection}/${row.entry_id}:`,
				error,
			);
		}
	}

	return totalPruned;
}
