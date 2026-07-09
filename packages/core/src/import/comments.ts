/**
 * Comment import functions
 *
 * Import comments from the WordPress plugin API into EmDash's native
 * comments table, preserving authors, dates, threading, and status.
 */

import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import type { Database } from "../database/types.js";
import { invalidateCommentObjectCache } from "../object-cache/index.js";

/**
 * Plugin API comment format (matches /emdash/v1/comments items)
 */
export interface PluginComment {
	id: number;
	post_id: number;
	parent_id: number | null;
	author_name: string;
	author_email: string;
	/** Plain-text body (the plugin strips HTML) */
	body: string;
	/** ISO 8601 UTC timestamp */
	date_gmt: string;
	status: "approved" | "pending";
}

/**
 * Result of comment import operation
 */
export interface CommentsImportResult {
	/** Number of comments created */
	imported: number;
	/** Comments skipped (unresolvable post reference or already imported) */
	skipped: number;
	/** Errors encountered */
	errors: Array<{ comment: string; error: string }>;
}

/**
 * Import comments from the plugin API.
 *
 * Preserves original timestamps and threading. Comments whose post was
 * not imported (no entry in `contentIdMap`) are skipped. Re-running the
 * import is idempotent: a comment with the same post, author email, and
 * timestamp is not created twice.
 *
 * @param comments - Comments from the plugin API (all pages, flat)
 * @param db - Database connection
 * @param contentIdMap - WP post ID -> EmDash content ID
 * @param collectionMap - WP post ID -> EmDash collection slug
 * @param rootIds - Optional pre-seeded WP-comment-ID -> EmDash-root-ID map.
 *   The chunked import passes the map accumulated from earlier pages so a
 *   reply in page N can thread onto a parent imported in page N-1; the
 *   function adds this page's entries to it.
 */
export async function importCommentsFromPlugin(
	comments: PluginComment[],
	db: Kysely<Database>,
	contentIdMap: Map<number, string>,
	collectionMap: Map<number, string>,
	rootIds?: Map<number, string>,
): Promise<CommentsImportResult> {
	const result: CommentsImportResult = {
		imported: 0,
		skipped: 0,
		errors: [],
	};

	// WP comment ID -> EmDash comment ID, for parent threading
	const commentIdMap = new Map<number, string>();

	// WP comment ID -> EmDash ID of its top-level ancestor. EmDash threads
	// are one level deep (assembleThreads nests replies under roots only),
	// so deeper WP threads are flattened onto their root comment.
	const rootIdMap = rootIds ?? new Map<number, string>();

	// Parents must exist before children reference them; WP comment IDs
	// are chronological, so ID order guarantees parents come first.
	const sorted = comments.toSorted((a, b) => a.id - b.id);

	for (const comment of sorted) {
		const label = `${comment.author_name || "Anonymous"} (${comment.date_gmt})`;
		try {
			const contentId = contentIdMap.get(comment.post_id);
			const collection = collectionMap.get(comment.post_id);
			if (!contentId || !collection) {
				result.skipped++;
				continue;
			}

			const parsed = new Date(comment.date_gmt);
			const createdAt = Number.isNaN(parsed.getTime())
				? new Date().toISOString()
				: parsed.toISOString();

			// Idempotency: same post + author + timestamp + body = already
			// imported (body included so same-second comments from one author
			// don't collide). ponytail: one SELECT per comment — fine at
			// import scale; batch with WHERE IN for six-figure comment counts.
			const existing = await db
				.selectFrom("_emdash_comments")
				.select("id")
				.where("content_id", "=", contentId)
				.where("author_email", "=", comment.author_email)
				.where("created_at", "=", createdAt)
				.where("body", "=", comment.body)
				.executeTakeFirst();
			const parentId =
				comment.parent_id !== null ? (rootIdMap.get(comment.parent_id) ?? null) : null;

			if (existing) {
				commentIdMap.set(comment.id, existing.id);
				rootIdMap.set(comment.id, parentId ?? existing.id);
				result.skipped++;
				continue;
			}

			const id = ulid();

			await db
				.insertInto("_emdash_comments")
				.values({
					id,
					collection,
					content_id: contentId,
					parent_id: parentId,
					author_name: comment.author_name || "Anonymous",
					author_email: comment.author_email,
					author_user_id: null,
					body: comment.body,
					status: comment.status,
					ip_hash: null,
					user_agent: null,
					moderation_metadata: null,
					created_at: createdAt,
					updated_at: createdAt,
				})
				.execute();

			commentIdMap.set(comment.id, id);
			rootIdMap.set(comment.id, parentId ?? id);
			result.imported++;
		} catch (error) {
			result.errors.push({
				comment: label,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (result.imported > 0) {
		invalidateCommentObjectCache();
	}

	return result;
}
