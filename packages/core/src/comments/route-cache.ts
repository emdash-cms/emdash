import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";
import { chunks, SQL_BATCH_SIZE } from "../utils/chunks.js";

export async function getCommentRouteCacheTags(
	db: Kysely<Database>,
	ids: string[],
	action: "approve" | "spam" | "trash" | "delete",
): Promise<string[]> {
	const tags = new Set<string>();
	for (const batch of chunks([...new Set(ids)], SQL_BATCH_SIZE)) {
		const comments = await db
			.selectFrom("_emdash_comments")
			.select(["collection", "content_id", "status"])
			.where("id", "in", batch)
			.execute();

		if (action === "delete") {
			const replies = await db
				.selectFrom("_emdash_comments")
				.select(["collection", "content_id", "status"])
				.where("parent_id", "in", batch)
				.where("status", "=", "approved")
				.execute();
			comments.push(...replies);
		}

		for (const comment of comments) {
			const changesVisibility =
				action === "approve" ? comment.status !== "approved" : comment.status === "approved";
			if (changesVisibility) {
				tags.add(comment.collection);
				tags.add(comment.content_id);
			}
		}
	}
	return [...tags];
}
