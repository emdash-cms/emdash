/**
 * Comment handlers — business logic for comment API routes.
 *
 * Standalone functions that return ApiResult<T>. Routes are thin wrappers.
 */

import { sql, type Kysely, type RawBuilder } from "kysely";

import { clientNetwork } from "../../auth/rate-limit.js";
import { CommentRepository } from "../../database/repositories/comment.js";
import type { Comment, CommentStatus, PublicComment } from "../../database/repositories/comment.js";
import { InvalidCursorError } from "../../database/repositories/types.js";
import type { Database } from "../../database/types.js";
import { IdentifierError, validateIdentifier } from "../../database/validate.js";
import { isMissingTableError } from "../../utils/db-errors.js";
import type { ApiResult } from "../types.js";

// ---------------------------------------------------------------------------
// Public: Entry visibility
// ---------------------------------------------------------------------------

/** SQL condition on an `ec_*` row: the entry is published and not in the trash. */
export const publicEntryCondition = sql<boolean>`status = 'published' AND deleted_at IS NULL`;

/** `publicEntryCondition` for one entry, as an `EXISTS` to fold into a comment query. */
export function publishedEntryExists(collection: string, contentId: string): RawBuilder<boolean> {
	validateIdentifier(collection, "collection");
	return sql<boolean>`EXISTS (
		SELECT 1 FROM ${sql.ref(`ec_${collection}`)}
		WHERE id = ${contentId} AND ${publicEntryCondition}
	)`;
}

/** True for errors raised because the collection name has no content table. */
export function isUnknownCollectionError(error: unknown): boolean {
	return error instanceof IdentifierError || isMissingTableError(error);
}

// ---------------------------------------------------------------------------
// Public: List approved comments for content
// ---------------------------------------------------------------------------

export async function handleCommentList(
	db: Kysely<Database>,
	collection: string,
	contentId: string,
	options: { limit?: number; cursor?: string; threaded?: boolean } = {},
): Promise<ApiResult<{ items: PublicComment[]; nextCursor?: string; total: number }>> {
	try {
		const { rows } = await sql<{ total: number | string; visible: number | string }>`
			SELECT
				(SELECT COUNT(*) FROM _emdash_comments
					WHERE collection = ${collection} AND content_id = ${contentId} AND status = 'approved'
				) AS total,
				CASE WHEN ${publishedEntryExists(collection, contentId)} THEN 1 ELSE 0 END AS visible
		`.execute(db);
		if (Number(rows[0]?.visible ?? 0) !== 1) {
			return { success: false, error: { code: "NOT_FOUND", message: "Content not found" } };
		}
		const total = Number(rows[0]?.total ?? 0);

		const repo = new CommentRepository(db);

		let publicItems: PublicComment[];
		let nextCursor: string | undefined;

		if (options.threaded) {
			// Threaded mode: fetch all approved comments (capped) so threading
			// doesn't lose children that would fall on later pages.
			const MAX_THREADED = 500;
			const result = await repo.findByContent(collection, contentId, {
				status: "approved",
				limit: MAX_THREADED,
			});
			const threaded = CommentRepository.assembleThreads(result.items);
			publicItems = threaded.map((c) => CommentRepository.toPublicComment(c));
			// No cursor for threaded mode — all comments returned at once
		} else {
			const result = await repo.findByContent(collection, contentId, {
				status: "approved",
				limit: options.limit,
				cursor: options.cursor,
			});
			publicItems = result.items.map((c) => CommentRepository.toPublicComment(c));
			nextCursor = result.nextCursor;
		}

		return {
			success: true,
			data: {
				items: publicItems,
				nextCursor,
				total,
			},
		};
	} catch (error) {
		if (error instanceof InvalidCursorError) {
			return {
				success: false,
				error: { code: "INVALID_CURSOR", message: error.message },
			};
		}
		if (isUnknownCollectionError(error)) {
			return { success: false, error: { code: "NOT_FOUND", message: "Content not found" } };
		}
		console.error("Comment list error:", error);
		return {
			success: false,
			error: {
				code: "COMMENT_LIST_ERROR",
				message: "Failed to list comments",
			},
		};
	}
}

// ---------------------------------------------------------------------------
// Admin: Moderation inbox
// ---------------------------------------------------------------------------

export async function handleCommentInbox(
	db: Kysely<Database>,
	options: {
		status?: CommentStatus;
		collection?: string;
		search?: string;
		limit?: number;
		cursor?: string;
	} = {},
): Promise<ApiResult<{ items: Comment[]; nextCursor?: string }>> {
	try {
		const repo = new CommentRepository(db);
		const status = options.status ?? "pending";

		const result = await repo.findByStatus(status, {
			collection: options.collection,
			search: options.search,
			limit: options.limit,
			cursor: options.cursor,
		});

		return {
			success: true,
			data: {
				items: result.items,
				nextCursor: result.nextCursor,
			},
		};
	} catch (error) {
		if (error instanceof InvalidCursorError) {
			return {
				success: false,
				error: { code: "INVALID_CURSOR", message: error.message },
			};
		}
		console.error("Comment inbox error:", error);
		return {
			success: false,
			error: {
				code: "COMMENT_INBOX_ERROR",
				message: "Failed to list comments",
			},
		};
	}
}

// ---------------------------------------------------------------------------
// Admin: Status counts for inbox badges
// ---------------------------------------------------------------------------

export async function handleCommentCounts(
	db: Kysely<Database>,
): Promise<ApiResult<Record<CommentStatus, number>>> {
	try {
		const repo = new CommentRepository(db);
		const counts = await repo.countByStatus();
		return { success: true, data: counts };
	} catch (error) {
		console.error("Comment counts error:", error);
		return {
			success: false,
			error: {
				code: "COMMENT_COUNTS_ERROR",
				message: "Failed to get comment counts",
			},
		};
	}
}

// ---------------------------------------------------------------------------
// Admin: Get single comment detail
// ---------------------------------------------------------------------------

export async function handleCommentGet(
	db: Kysely<Database>,
	id: string,
): Promise<ApiResult<Comment>> {
	try {
		const repo = new CommentRepository(db);
		const comment = await repo.findById(id);

		if (!comment) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Comment not found: ${id}` },
			};
		}

		return { success: true, data: comment };
	} catch (error) {
		console.error("Comment get error:", error);
		return {
			success: false,
			error: {
				code: "COMMENT_GET_ERROR",
				message: "Failed to get comment",
			},
		};
	}
}

// ---------------------------------------------------------------------------
// Admin: Change comment status
// ---------------------------------------------------------------------------

export async function handleCommentStatusChange(
	db: Kysely<Database>,
	id: string,
	status: CommentStatus,
): Promise<ApiResult<Comment>> {
	try {
		const repo = new CommentRepository(db);
		const updated = await repo.updateStatus(id, status);

		if (!updated) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Comment not found: ${id}` },
			};
		}

		return { success: true, data: updated };
	} catch (error) {
		console.error("Comment status change error:", error);
		return {
			success: false,
			error: {
				code: "COMMENT_STATUS_ERROR",
				message: "Failed to update comment status",
			},
		};
	}
}

// ---------------------------------------------------------------------------
// Admin: Hard delete comment
// ---------------------------------------------------------------------------

export async function handleCommentDelete(
	db: Kysely<Database>,
	id: string,
): Promise<ApiResult<{ deleted: true }>> {
	try {
		const repo = new CommentRepository(db);
		const deleted = await repo.delete(id);

		if (!deleted) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Comment not found: ${id}` },
			};
		}

		return { success: true, data: { deleted: true } };
	} catch (error) {
		console.error("Comment delete error:", error);
		return {
			success: false,
			error: {
				code: "COMMENT_DELETE_ERROR",
				message: "Failed to delete comment",
			},
		};
	}
}

// ---------------------------------------------------------------------------
// Admin: Bulk operations
// ---------------------------------------------------------------------------

export async function handleCommentBulk(
	db: Kysely<Database>,
	ids: string[],
	action: "approve" | "spam" | "trash" | "delete",
): Promise<ApiResult<{ affected: number }>> {
	try {
		const repo = new CommentRepository(db);

		let affected: number;
		if (action === "delete") {
			affected = await repo.bulkDelete(ids);
		} else {
			const statusMap: Record<string, CommentStatus> = {
				approve: "approved",
				spam: "spam",
				trash: "trash",
			};
			affected = await repo.bulkUpdateStatus(ids, statusMap[action]);
		}

		return { success: true, data: { affected } };
	} catch (error) {
		console.error("Comment bulk error:", error);
		return {
			success: false,
			error: {
				code: "COMMENT_BULK_ERROR",
				message: "Failed to perform bulk operation",
			},
		};
	}
}

/**
 * Hash an IP address for storage (never store cleartext IPs).
 *
 * The hash keys the comment rate limit and reaction votes, so the address
 * is reduced with `clientNetwork` first.
 *
 * Uses full SHA-256 with a site-specific salt to prevent rainbow-table
 * recovery of IPs. The salt must be provided by the caller — typically
 * via `resolveSecretsCached(db).ipSalt` from `#config/secrets.js`. The
 * salt is generated and persisted on first need so it's stable across
 * requests within a deployment but unique per install.
 */
export async function hashIp(ip: string, salt: string): Promise<string> {
	const data = `ip:${salt}:${clientNetwork(ip)}`;
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
	return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
