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
import type { Kysely } from "kysely";

import { cleanupExpiredChallenges } from "./auth/challenge-store.js";
import { MediaRepository } from "./database/repositories/media.js";
import { RevisionRepository } from "./database/repositories/revision.js";
import type { Database } from "./database/types.js";
import { removeUploadAttempt } from "./media/upload-attempts.js";
import { cleanupMediaUsage } from "./media/usage/cleanup.js";
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
	uploadAttempts: number;
	revisionsPruned: number;
	mediaUsage: number;
}

const REVISION_KEEP_COUNT = 50;
const REVISION_PRUNE_BATCH_SIZE = 10;

/**
 * Run all system cleanup tasks.
 *
 * Safe to call frequently -- each subsystem tolerates repeated calls, and
 * repeated calls with nothing to clean are cheap.
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
		uploadAttempts: -1,
		revisionsPruned: -1,
		mediaUsage: -1,
	};

	// 1. Passkey challenges (expire after 60s, clean anything past 5 min)
	try {
		result.challenges = await cleanupExpiredChallenges(db);
	} catch (error) {
		console.error("[cleanup] Failed to clean expired challenges:", error);
	}

	// 2. Magic link / invite / signup tokens
	try {
		// Cast needed: Database extends AuthTables but uses Generated<> wrappers
		// that confuse structural checks. The adapter casts internally anyway.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Database uses Generated<> wrappers incompatible with AuthTables structurally; safe at runtime
		const authAdapter = createKyselyAdapter(db as unknown as Kysely<AuthTables>);
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

	// 4. Uploaded objects that lost publication races or outlived their media row
	try {
		const mediaRepo = new MediaRepository(db);
		const completedAttemptsDeleted = await mediaRepo.deleteCompletedUploadAttempts();
		if (!storage) {
			result.uploadAttempts = completedAttemptsDeleted;
		} else {
			const storageKeys = await mediaRepo.findUploadAttemptsForCleanup();
			let attemptsDeleted = completedAttemptsDeleted;
			for (const storageKey of storageKeys) {
				if (await removeUploadAttempt(storage, mediaRepo, storageKey)) {
					attemptsDeleted++;
				}
			}
			result.uploadAttempts = attemptsDeleted;
		}
	} catch (error) {
		console.error("[cleanup] Failed to clean media upload attempts:", error);
	}

	try {
		result.revisionsPruned = await pruneQueuedRevisions(db);
	} catch (error) {
		console.error("[cleanup] Failed to prune revisions:", error);
	}

	try {
		const mediaUsage = await cleanupMediaUsage(db);
		result.mediaUsage = mediaUsage.status === "failed" ? -1 : mediaUsage.deletedRows;
	} catch (error) {
		console.error("[cleanup] Failed to clean media usage:", error);
	}

	return result;
}

async function pruneQueuedRevisions(db: Kysely<Database>): Promise<number> {
	const queued = await db
		.selectFrom("_emdash_revision_prune_queue")
		.selectAll()
		.orderBy("revision_id")
		.limit(REVISION_PRUNE_BATCH_SIZE)
		.execute();
	const revisionRepo = new RevisionRepository(db);
	let totalPruned = 0;

	for (const row of queued) {
		try {
			totalPruned += await revisionRepo.pruneQueuedEntry(
				row.collection,
				row.entry_id,
				row.revision_id,
				REVISION_KEEP_COUNT,
			);
		} catch (error) {
			console.error(
				`[cleanup] Failed to prune revisions for ${row.collection}/${row.entry_id}:`,
				error,
			);
		}
	}

	return totalPruned;
}
