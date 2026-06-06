/**
 * Comment query functions for Astro templates
 *
 * Same pattern as getMenu() — uses getDb() for ambient DB access.
 * These are called from .astro pages/components, not from API routes.
 */

import type { Kysely } from "kysely";

import { CommentRepository } from "../database/repositories/comment.js";
import type { PublicComment } from "../database/repositories/comment.js";
import type { Database } from "../database/types.js";
import { getDb } from "../loader.js";
import { cachedQuery, CacheNamespace } from "../object-cache/index.js";

export interface GetCommentsOptions {
	collection: string;
	contentId: string;
	threaded?: boolean;
}

export interface GetCommentsResult {
	items: PublicComment[];
	total: number;
}

/**
 * Get approved comments for a content item.
 *
 * @example
 * ```ts
 * import { getComments } from "emdash";
 *
 * const { items, total } = await getComments({
 *   collection: "posts",
 *   contentId: post.id,
 *   threaded: true,
 * });
 * ```
 */
export async function getComments(options: GetCommentsOptions): Promise<GetCommentsResult> {
	return cachedQuery({
		namespace: CacheNamespace.COMMENTS,
		key: `comments:${options.collection}:${options.contentId}:${options.threaded ? "t" : "f"}`,
		load: async () => {
			const db = await getDb();
			return getCommentsWithDb(db, options);
		},
	});
}

/**
 * Get approved comments with an explicit db handle.
 *
 * @internal Use `getComments()` in templates. This variant is for routes
 * that already have a database handle.
 */
export async function getCommentsWithDb(
	db: Kysely<Database>,
	options: GetCommentsOptions,
): Promise<GetCommentsResult> {
	const repo = new CommentRepository(db);

	const total = await repo.countByContent(options.collection, options.contentId, "approved");

	// Server-rendered: fetch all comments (capped for safety).
	// The API route handles paginated access; this is for full-page renders.
	const MAX_COMMENTS = 500;

	const result = await repo.findByContent(options.collection, options.contentId, {
		status: "approved",
		limit: MAX_COMMENTS,
	});

	if (options.threaded) {
		const threaded = CommentRepository.assembleThreads(result.items);
		const items = threaded.map((c) => CommentRepository.toPublicComment(c));
		return { items, total };
	}

	const items = result.items.map((c) => CommentRepository.toPublicComment(c));
	return { items, total };
}

/**
 * Get the count of approved comments for a content item.
 *
 * @example
 * ```ts
 * import { getCommentCount } from "emdash";
 *
 * const count = await getCommentCount("posts", post.id);
 * ```
 */
export async function getCommentCount(collection: string, contentId: string): Promise<number> {
	const db = await getDb();
	return getCommentCountWithDb(db, collection, contentId);
}

/**
 * Get comment count with an explicit db handle.
 *
 * @internal Use `getCommentCount()` in templates.
 */
export async function getCommentCountWithDb(
	db: Kysely<Database>,
	collection: string,
	contentId: string,
): Promise<number> {
	const repo = new CommentRepository(db);
	return repo.countByContent(collection, contentId, "approved");
}
