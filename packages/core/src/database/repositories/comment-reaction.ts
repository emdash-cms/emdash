import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import { SQL_BATCH_SIZE, chunks } from "../../utils/chunks.js";
import type { Database } from "../types.js";

/** Per-comment reaction counts: `{ like: 12, love: 3 }`. */
export type ReactionCounts = Record<string, number>;

export interface ToggleReactionInput {
	commentId: string;
	reaction: string;
	voterHash: string;
}

/**
 * Repository for comment reactions (likes / emoji).
 *
 * Reactions are deduped per (comment, voter, reaction) by a unique index, so
 * a second toggle of the same reaction by the same voter removes it.
 */
export class CommentReactionRepository {
	constructor(private db: Kysely<Database>) {}

	/**
	 * Toggle a reaction for a voter on a comment.
	 *
	 * @returns `{ reacted: true }` if the reaction was added, `{ reacted: false }`
	 *   if an existing reaction was removed.
	 */
	async toggle(input: ToggleReactionInput): Promise<{ reacted: boolean }> {
		const existing = await this.db
			.selectFrom("_emdash_comment_reactions")
			.select("id")
			.where("comment_id", "=", input.commentId)
			.where("voter_hash", "=", input.voterHash)
			.where("reaction", "=", input.reaction)
			.executeTakeFirst();

		if (existing) {
			await this.db.deleteFrom("_emdash_comment_reactions").where("id", "=", existing.id).execute();
			return { reacted: false };
		}

		await this.db
			.insertInto("_emdash_comment_reactions")
			.values({
				id: ulid(),
				comment_id: input.commentId,
				reaction: input.reaction,
				voter_hash: input.voterHash,
				created_at: new Date().toISOString(),
			})
			.execute();
		return { reacted: true };
	}

	/**
	 * Aggregate reaction counts for a set of comments.
	 *
	 * @returns a Map keyed by comment id; comments with no reactions are absent.
	 */
	async countsForComments(commentIds: string[]): Promise<Map<string, ReactionCounts>> {
		const result = new Map<string, ReactionCounts>();
		if (commentIds.length === 0) return result;

		for (const batch of chunks(commentIds, SQL_BATCH_SIZE)) {
			const rows = await this.db
				.selectFrom("_emdash_comment_reactions")
				.select(["comment_id", "reaction"])
				.select((eb) => eb.fn.count<number>("id").as("count"))
				.where("comment_id", "in", batch)
				.groupBy(["comment_id", "reaction"])
				.execute();

			for (const row of rows) {
				const counts = result.get(row.comment_id) ?? {};
				counts[row.reaction] = Number(row.count);
				result.set(row.comment_id, counts);
			}
		}

		return result;
	}

	/**
	 * Which reactions a given voter has set, per comment.
	 *
	 * @returns a Map keyed by comment id whose values are the reaction names the
	 *   voter has active on that comment.
	 */
	async viewerReactions(commentIds: string[], voterHash: string): Promise<Map<string, string[]>> {
		const result = new Map<string, string[]>();
		if (commentIds.length === 0) return result;

		for (const batch of chunks(commentIds, SQL_BATCH_SIZE)) {
			const rows = await this.db
				.selectFrom("_emdash_comment_reactions")
				.select(["comment_id", "reaction"])
				.where("comment_id", "in", batch)
				.where("voter_hash", "=", voterHash)
				.execute();

			for (const row of rows) {
				const list = result.get(row.comment_id) ?? [];
				list.push(row.reaction);
				result.set(row.comment_id, list);
			}
		}

		return result;
	}

	/**
	 * Count a voter's reactions within a recent time window (for rate limiting).
	 */
	async countRecentByVoter(voterHash: string, windowMinutes = 10): Promise<number> {
		const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
		const result = await this.db
			.selectFrom("_emdash_comment_reactions")
			.select((eb) => eb.fn.count<number>("id").as("count"))
			.where("voter_hash", "=", voterHash)
			.where("created_at", ">", cutoff)
			.executeTakeFirst();
		return Number(result?.count ?? 0);
	}
}
