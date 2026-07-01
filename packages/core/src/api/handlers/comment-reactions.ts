/**
 * Comment reaction handlers (Tier 1 of the best-in-class comments RFC).
 *
 * Business logic for toggling reactions and reading aggregate counts. Route
 * files stay thin wrappers; these return `ApiResult<T>`.
 */

import type { Kysely } from "kysely";

import {
	CommentReactionRepository,
	type ReactionCounts,
} from "#db/repositories/comment-reaction.js";
import type { Database } from "#db/types.js";

import { invalidateCommentObjectCache } from "../../object-cache/index.js";
import type { ApiResult } from "../types.js";

/** Max reactions a single voter may register per window before throttling. */
const REACTION_RATE_LIMIT = 30;
const REACTION_RATE_WINDOW_MINUTES = 10;

/**
 * Reactions the system accepts. Positive-only for now (matches the shipped
 * widget); kept as an allowlist so a voter can't spam arbitrary reaction
 * strings and bloat a comment's count map. Extend (or make configurable) as
 * the UI grows.
 */
const ALLOWED_REACTIONS: ReadonlySet<string> = new Set(["like"]);

export interface ReactionToggleResult {
	commentId: string;
	reaction: string;
	/** true if the reaction was added, false if an existing one was removed */
	reacted: boolean;
	/** updated counts for this comment after the toggle */
	counts: ReactionCounts;
}

export interface ReactionCountsResult {
	/** comment id -> reaction counts */
	reactions: Record<string, ReactionCounts>;
	/** comment id -> reactions the current voter has active (omitted if anonymous) */
	viewer?: Record<string, string[]>;
}

/**
 * Toggle a reaction for a voter on an approved comment belonging to the given
 * content item. Rate-limited per voter.
 */
export async function handleReactionToggle(
	db: Kysely<Database>,
	params: {
		collection: string;
		contentId: string;
		commentId: string;
		reaction: string;
		voterHash: string;
	},
): Promise<ApiResult<ReactionToggleResult>> {
	try {
		const { collection, contentId, commentId, reaction, voterHash } = params;

		if (!ALLOWED_REACTIONS.has(reaction)) {
			return {
				success: false,
				error: { code: "VALIDATION_ERROR", message: "Unsupported reaction" },
			};
		}

		// The comment must exist, be approved, and belong to this content item.
		const comment = await db
			.selectFrom("_emdash_comments")
			.select(["id", "status"])
			.where("id", "=", commentId)
			.where("collection", "=", collection)
			.where("content_id", "=", contentId)
			.executeTakeFirst();

		if (!comment) {
			return { success: false, error: { code: "NOT_FOUND", message: "Comment not found" } };
		}
		if (comment.status !== "approved") {
			return {
				success: false,
				error: { code: "COMMENT_NOT_APPROVED", message: "Cannot react to this comment" },
			};
		}

		const repo = new CommentReactionRepository(db);

		const recent = await repo.countRecentByVoter(voterHash, REACTION_RATE_WINDOW_MINUTES);
		if (recent >= REACTION_RATE_LIMIT) {
			return {
				success: false,
				error: { code: "RATE_LIMITED", message: "Too many reactions. Please try again later." },
			};
		}

		const { reacted } = await repo.toggle({ commentId, reaction, voterHash });
		const countsMap = await repo.countsForComments([commentId]);

		// Reaction counts (and `best` ordering) are folded into cached getComments
		// reads, so a toggle must orphan them.
		invalidateCommentObjectCache();

		return {
			success: true,
			data: { commentId, reaction, reacted, counts: countsMap.get(commentId) ?? {} },
		};
	} catch {
		return {
			success: false,
			error: { code: "REACTION_TOGGLE_ERROR", message: "Failed to toggle reaction" },
		};
	}
}

/**
 * Read aggregate reaction counts for every approved comment on a content item,
 * plus (optionally) which reactions the current voter has active.
 */
export async function handleReactionCounts(
	db: Kysely<Database>,
	collection: string,
	contentId: string,
	voterHash?: string,
): Promise<ApiResult<ReactionCountsResult>> {
	try {
		const comments = await db
			.selectFrom("_emdash_comments")
			.select("id")
			.where("collection", "=", collection)
			.where("content_id", "=", contentId)
			.where("status", "=", "approved")
			.execute();

		const ids = comments.map((c) => c.id);
		const repo = new CommentReactionRepository(db);

		const countsMap = await repo.countsForComments(ids);
		const reactions: Record<string, ReactionCounts> = {};
		for (const [id, counts] of countsMap) {
			reactions[id] = counts;
		}

		const data: ReactionCountsResult = { reactions };

		if (voterHash) {
			const viewerMap = await repo.viewerReactions(ids, voterHash);
			const viewer: Record<string, string[]> = {};
			for (const [id, list] of viewerMap) {
				viewer[id] = list;
			}
			data.viewer = viewer;
		}

		return { success: true, data };
	} catch {
		return {
			success: false,
			error: { code: "REACTION_COUNTS_ERROR", message: "Failed to read reactions" },
		};
	}
}
