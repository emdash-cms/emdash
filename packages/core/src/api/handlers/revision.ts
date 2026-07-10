/**
 * Revision history handlers
 */

import type { Kysely } from "kysely";

import { ContentRepository } from "../../database/repositories/content.js";
import { RevisionRepository, type Revision } from "../../database/repositories/revision.js";
import { withTransaction } from "../../database/transaction.js";
import type { Database } from "../../database/types.js";
import type { ApiResult, ContentResponse } from "../types.js";

export interface RevisionListResponse {
	items: Revision[];
	total: number;
}

export interface RevisionResponse {
	item: Revision;
}

/**
 * List revisions for a content entry
 */
export async function handleRevisionList(
	db: Kysely<Database>,
	collection: string,
	entryId: string,
	params: { limit?: number } = {},
): Promise<ApiResult<RevisionListResponse>> {
	try {
		const repo = new RevisionRepository(db);
		const [items, total] = await Promise.all([
			repo.findByEntry(collection, entryId, { limit: Math.min(params.limit || 50, 100) }),
			repo.countByEntry(collection, entryId),
		]);

		return {
			success: true,
			data: { items, total },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "REVISION_LIST_ERROR",
				message: "Failed to list revisions",
			},
		};
	}
}

/**
 * Get a specific revision
 */
export async function handleRevisionGet(
	db: Kysely<Database>,
	revisionId: string,
): Promise<ApiResult<RevisionResponse>> {
	try {
		const repo = new RevisionRepository(db);
		const item = await repo.findById(revisionId);

		if (!item) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Revision not found: ${revisionId}`,
				},
			};
		}

		return {
			success: true,
			data: { item },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "REVISION_GET_ERROR",
				message: "Failed to get revision",
			},
		};
	}
}

/**
 * Restore a revision (updates content to this revision's data and creates new revision)
 */
export async function handleRevisionRestore(
	db: Kysely<Database>,
	revisionId: string,
	callerUserId: string,
): Promise<ApiResult<ContentResponse>> {
	try {
		const revisionRepo = new RevisionRepository(db);

		// Get the revision
		const revision = await revisionRepo.findById(revisionId);
		if (!revision) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Revision not found: ${revisionId}`,
				},
			};
		}

		// Extract _slug from revision data (stored as metadata, not a real column)
		const { _slug, ...fieldData } = revision.data;

		// Atomically update content and create a new revision to record the restore.
		// If either operation fails, neither is committed (on engines that support
		// transactions; on D1, withTransaction falls back to sequential execution).
		const item = await withTransaction(db, async (trx) => {
			const trxContentRepo = new ContentRepository(trx);
			const trxRevisionRepo = new RevisionRepository(trx);

			const updated = await trxContentRepo.update(revision.collection, revision.entryId, {
				data: fieldData,
				slug: typeof _slug === "string" ? _slug : undefined,
			});

			await trxRevisionRepo.create({
				collection: revision.collection,
				entryId: revision.entryId,
				data: revision.data,
				authorId: callerUserId,
			});

			return updated;
		});

		// Fire-and-forget: prune old revisions to prevent unbounded growth
		const pruneRepo = new RevisionRepository(db);
		void pruneRepo.pruneOldRevisions(revision.collection, revision.entryId, 50).catch(() => {});

		return {
			success: true,
			data: { item },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "REVISION_RESTORE_ERROR",
				message: "Failed to restore revision",
			},
		};
	}
}
