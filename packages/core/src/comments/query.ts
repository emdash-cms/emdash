/**
 * Comment query functions for Astro templates
 *
 * Same pattern as getMenu() — uses getDb() for ambient DB access.
 * These are called from .astro pages/components, not from API routes.
 */

import type { Kysely } from "kysely";

import { CommentReactionRepository } from "../database/repositories/comment-reaction.js";
import { CommentRepository } from "../database/repositories/comment.js";
import type { PublicComment } from "../database/repositories/comment.js";
import type { Database } from "../database/types.js";
import { getDb } from "../loader.js";
import { reactionScore } from "./ranking.js";

export interface GetCommentsOptions {
	collection: string;
	contentId: string;
	threaded?: boolean;
	/** Attach aggregate reaction counts to each comment. */
	reactions?: boolean;
	/**
	 * Order of top-level comments. `oldest` (default) preserves the existing
	 * chronological display; `best` ranks by Wilson-scored reactions (implies
	 * `reactions`). Replies always stay chronological.
	 */
	sort?: "oldest" | "best";
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
	const db = await getDb();
	return getCommentsWithDb(db, options);
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

	const items: PublicComment[] = options.threaded
		? CommentRepository.assembleThreads(result.items).map((c) =>
				CommentRepository.toPublicComment(c),
			)
		: result.items.map((c) => CommentRepository.toPublicComment(c));

	// `best` sort needs reaction data, so it implies reactions.
	if (options.reactions || options.sort === "best") {
		await attachReactions(db, items);
		if (options.sort === "best") {
			sortByBest(items);
		}
	}

	return { items, total };
}

/**
 * Attach aggregate reaction counts to a list of public comments (and their
 * replies), in a single batched query.
 */
async function attachReactions(db: Kysely<Database>, items: PublicComment[]): Promise<void> {
	const ids: string[] = [];
	for (const comment of items) {
		ids.push(comment.id);
		if (comment.replies) {
			for (const reply of comment.replies) ids.push(reply.id);
		}
	}
	if (ids.length === 0) return;

	const counts = await new CommentReactionRepository(db).countsForComments(ids);

	const assign = (comment: PublicComment) => {
		const reactions = counts.get(comment.id);
		if (reactions) comment.reactions = reactions;
	};
	for (const comment of items) {
		assign(comment);
		comment.replies?.forEach(assign);
	}
}

/**
 * Sort top-level comments by Wilson-scored reactions (descending), tie-broken
 * by oldest-first to keep ordering stable.
 */
function sortByBest(items: PublicComment[]): void {
	items.sort((a, b) => {
		const scoreDelta = reactionScore(b.reactions ?? {}) - reactionScore(a.reactions ?? {});
		if (scoreDelta !== 0) return scoreDelta;
		if (a.createdAt < b.createdAt) return -1;
		if (a.createdAt > b.createdAt) return 1;
		return 0;
	});
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
