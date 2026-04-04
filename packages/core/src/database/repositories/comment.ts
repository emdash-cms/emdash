import { sql, type ExpressionBuilder, type Kysely } from "kysely";
import { ulid } from "ulidx";

import type { Database } from "../types.js";
import { encodeCursor, decodeCursor, type FindManyResult } from "./types.js";

/** Matches LIKE wildcard characters and the escape character itself */
const LIKE_ESCAPE_RE = /[%_\\]/g;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommentStatus = "pending" | "approved" | "spam" | "trash";

export interface Comment {
	id: string;
	collection: string;
	contentId: string;
	parentId: string | null;
	authorName: string;
	authorEmail: string;
	authorUserId: string | null;
	body: string;
	status: CommentStatus;
	ipHash: string | null;
	userAgent: string | null;
	moderationMetadata: Record<string, unknown> | null;
	createdAt: string;
	updatedAt: string;
}

/** Public-facing comment shape — no private fields */
export interface PublicComment {
	id: string;
	parentId: string | null;
	authorName: string;
	isRegisteredUser: boolean;
	body: string;
	createdAt: string;
	replies?: PublicComment[];
}

export interface CreateCommentInput {
	collection: string;
	contentId: string;
	parentId?: string | null;
	authorName: string;
	authorEmail: string;
	authorUserId?: string | null;
	body: string;
	status?: CommentStatus;
	ipHash?: string | null;
	userAgent?: string | null;
	moderationMetadata?: Record<string, unknown> | null;
}

export interface CommentFindOptions {
	status?: CommentStatus;
	collection?: string;
	search?: string;
	limit?: number;
	cursor?: string;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class CommentRepository {
	constructor(private db: Kysely<Database>) {}

	/**
	 * Create a new comment
	 */
	async create(input: CreateCommentInput): Promise<Comment> {
		const id = ulid();
		const now = new Date().toISOString();

		await this.db
			.insertInto("_emdash_comments")
			.values({
				id,
				collection: input.collection,
				content_id: input.contentId,
				parent_id: input.parentId ?? null,
				author_name: input.authorName,
				author_email: input.authorEmail,
				author_user_id: input.authorUserId ?? null,
				body: input.body,
				status: input.status ?? "pending",
				ip_hash: input.ipHash ?? null,
				user_agent: input.userAgent ?? null,
				moderation_metadata: input.moderationMetadata
					? JSON.stringify(input.moderationMetadata)
					: null,
				created_at: now,
				updated_at: now,
			})
			.execute();

		const comment = await this.findById(id);
		if (!comment) {
			throw new Error("Failed to create comment");
		}
		return comment;
	}

	/**
	 * Find comment by ID
	 */
	async findById(id: string): Promise<Comment | null> {
		const row = await this.db
			.selectFrom("_emdash_comments")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();

		return row ? this.rowToComment(row) : null;
	}

	/**
	 * Find comments for a content item with optional status filter.
	 * Results are ordered by created_at ASC (oldest first) for display.
	 */
	async findByContent(
		collection: string,
		contentId: string,
		options: { status?: CommentStatus; limit?: number; cursor?: string } = {},
	): Promise<FindManyResult<Comment>> {
		const limit = Math.min(options.limit || 50, 100);

		let query = this.db
			.selectFrom("_emdash_comments")
			.selectAll()
			.where("collection", "=", collection)
			.where("content_id", "=", contentId);

		if (options.status) {
			query = query.where("status", "=", options.status);
		}

		// Cursor pagination (ascending by created_at)
		if (options.cursor) {
			const decoded = decodeCursor(options.cursor);
			if (decoded) {
				query = query.where((eb: ExpressionBuilder<Database, "_emdash_comments">) =>
					eb.or([
						eb("created_at", ">", decoded.orderValue),
						eb.and([eb("created_at", "=", decoded.orderValue), eb("id", ">", decoded.id)]),
					]),
				);
			}
		}

		query = query
			.orderBy("created_at", "asc")
			.orderBy("id", "asc")
			.limit(limit + 1);

		const rows = await query.execute();
		const hasMore = rows.length > limit;
		const items = rows.slice(0, limit).map((r) => this.rowToComment(r));

		const result: FindManyResult<Comment> = { items };
		if (hasMore && items.length > 0) {
			const last = items.at(-1)!;
			result.nextCursor = encodeCursor(last.createdAt, last.id);
		}
		return result;
	}

	/**
	 * Find comments by status (moderation inbox).
	 * Results are ordered by created_at DESC (newest first).
	 */
	async findByStatus(
		status: CommentStatus,
		options: { collection?: string; search?: string; limit?: number; cursor?: string } = {},
	): Promise<FindManyResult<Comment>> {
		const limit = Math.min(options.limit || 50, 100);

		let query = this.db.selectFrom("_emdash_comments").selectAll().where("status", "=", status);

		if (options.collection) {
			query = query.where("collection", "=", options.collection);
		}

		if (options.search) {
			// Escape LIKE wildcards to prevent them acting as SQL pattern characters
			const escaped = options.search.replace(LIKE_ESCAPE_RE, (ch) => `\\${ch}`);
			const term = `%${escaped}%`;
			query = query.where((eb: ExpressionBuilder<Database, "_emdash_comments">) =>
				eb.or([
					sql<boolean>`author_name LIKE ${term} ESCAPE '\\'`,
					sql<boolean>`author_email LIKE ${term} ESCAPE '\\'`,
					sql<boolean>`body LIKE ${term} ESCAPE '\\'`,
				]),
			);
		}

		// Cursor pagination (descending by created_at)
		if (options.cursor) {
			const decoded = decodeCursor(options.cursor);
			if (decoded) {
				query = query.where((eb: ExpressionBuilder<Database, "_emdash_comments">) =>
					eb.or([
						eb("created_at", "<", decoded.orderValue),
						eb.and([eb("created_at", "=", decoded.orderValue), eb("id", "<", decoded.id)]),
					]),
				);
			}
		}

		query = query
			.orderBy("created_at", "desc")
			.orderBy("id", "desc")
			.limit(limit + 1);

		const rows = await query.execute();
		const hasMore = rows.length > limit;
		const items = rows.slice(0, limit).map((r) => this.rowToComment(r));

		const result: FindManyResult<Comment> = { items };
		if (hasMore && items.length > 0) {
			const last = items.at(-1)!;
			result.nextCursor = encodeCursor(last.createdAt, last.id);
		}
		return result;
	}

	/**
	 * Update comment status
	 */
	async updateStatus(id: string, status: CommentStatus): Promise<Comment | null> {
		const now = new Date().toISOString();

		await this.db
			.updateTable("_emdash_comments")
			.set({ status, updated_at: now })
			.where("id", "=", id)
			.execute();

		return this.findById(id);
	}

	/**
	 * Bulk update comment statuses
	 */
	async bulkUpdateStatus(ids: string[], status: CommentStatus): Promise<number> {
		if (ids.length === 0) return 0;

		const now = new Date().toISOString();

		const result = await this.db
			.updateTable("_emdash_comments")
			.set({ status, updated_at: now })
			.where("id", "in", ids)
			.executeTakeFirst();

		return Number(result.numUpdatedRows ?? 0);
	}

	/**
	 * Hard-delete a single comment. Replies cascade via FK.
	 */
	async delete(id: string): Promise<boolean> {
		const result = await this.db
			.deleteFrom("_emdash_comments")
			.where("id", "=", id)
			.executeTakeFirst();

		return (result.numDeletedRows ?? 0) > 0;
	}

	/**
	 * Bulk hard-delete comments
	 */
	async bulkDelete(ids: string[]): Promise<number> {
		if (ids.length === 0) return 0;

		const result = await this.db
			.deleteFrom("_emdash_comments")
			.where("id", "in", ids)
			.executeTakeFirst();

		return Number(result.numDeletedRows ?? 0);
	}

	/**
	 * Delete all comments for a content item (cascade on content deletion)
	 */
	async deleteByContent(collection: string, contentId: string): Promise<number> {
		const result = await this.db
			.deleteFrom("_emdash_comments")
			.where("collection", "=", collection)
			.where("content_id", "=", contentId)
			.executeTakeFirst();

		return Number(result.numDeletedRows ?? 0);
	}

	/**
	 * Count comments for a content item, optionally filtered by status
	 */
	async countByContent(
		collection: string,
		contentId: string,
		status?: CommentStatus,
	): Promise<number> {
		let query = this.db
			.selectFrom("_emdash_comments")
			.select((eb) => eb.fn.count("id").as("count"))
			.where("collection", "=", collection)
			.where("content_id", "=", contentId);

		if (status) {
			query = query.where("status", "=", status);
		}

		const result = await query.executeTakeFirst();
		return Number(result?.count ?? 0);
	}

	/**
	 * Count comments grouped by status (for inbox badges)
	 *
	 * Uses four parallel COUNT queries with WHERE filters to leverage partial indexes
	 * (idx_comments_pending, idx_comments_approved, idx_comments_spam, idx_comments_trash)
	 * instead of a full table GROUP BY scan.
	 */
	async countByStatus(): Promise<Record<CommentStatus, number>> {
		// Execute four parallel COUNT queries, each using its partial index
		const [pending, approved, spam, trash] = await Promise.all([
			this.db
				.selectFrom("_emdash_comments")
				.select((eb) => eb.fn.count("id").as("count"))
				.where("status", "=", "pending")
				.executeTakeFirst(),
			this.db
				.selectFrom("_emdash_comments")
				.select((eb) => eb.fn.count("id").as("count"))
				.where("status", "=", "approved")
				.executeTakeFirst(),
			this.db
				.selectFrom("_emdash_comments")
				.select((eb) => eb.fn.count("id").as("count"))
				.where("status", "=", "spam")
				.executeTakeFirst(),
			this.db
				.selectFrom("_emdash_comments")
				.select((eb) => eb.fn.count("id").as("count"))
				.where("status", "=", "trash")
				.executeTakeFirst(),
		]);

		return {
			pending: Number(pending?.count ?? 0),
			approved: Number(approved?.count ?? 0),
			spam: Number(spam?.count ?? 0),
			trash: Number(trash?.count ?? 0),
		};
	}

	/**
	 * Count approved comments from a given email address.
	 * Used for "first time commenter" moderation logic.
	 */
	async countApprovedByEmail(email: string): Promise<number> {
		const result = await this.db
			.selectFrom("_emdash_comments")
			.select((eb) => eb.fn.count("id").as("count"))
			.where("author_email", "=", email)
			.where("status", "=", "approved")
			.executeTakeFirst();

		return Number(result?.count ?? 0);
	}

	/**
	 * Update the moderation metadata JSON on a comment
	 */
	async updateModerationMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
		await this.db
			.updateTable("_emdash_comments")
			.set({ moderation_metadata: JSON.stringify(metadata) })
			.where("id", "=", id)
			.execute();
	}

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	/**
	 * Assemble a flat list of comments into a threaded structure (1-level nesting)
	 */
	static assembleThreads(comments: Comment[]): Comment[] {
		const roots: Comment[] = [];
		const childrenMap = new Map<string, Comment[]>();

		for (const comment of comments) {
			if (comment.parentId) {
				const siblings = childrenMap.get(comment.parentId) ?? [];
				siblings.push(comment);
				childrenMap.set(comment.parentId, siblings);
			} else {
				roots.push(comment);
			}
		}

		// Attach children as a non-standard property — callers map to PublicComment.replies
		return roots.map((root) => ({
			...root,
			_replies: childrenMap.get(root.id) ?? [],
		})) as Comment[];
	}

	/**
	 * Convert a Comment to its public-facing shape
	 */
	static toPublicComment(comment: Comment & { _replies?: Comment[] }): PublicComment {
		const pub: PublicComment = {
			id: comment.id,
			parentId: comment.parentId,
			authorName: comment.authorName,
			isRegisteredUser: comment.authorUserId !== null,
			body: comment.body,
			createdAt: comment.createdAt,
		};

		if (comment._replies && comment._replies.length > 0) {
			pub.replies = comment._replies.map((r) => CommentRepository.toPublicComment(r));
		}

		return pub;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- selectAll returns runtime row
	private rowToComment(row: any): Comment {
		return {
			id: row.id,
			collection: row.collection,
			contentId: row.content_id,
			parentId: row.parent_id,
			authorName: row.author_name,
			authorEmail: row.author_email,
			authorUserId: row.author_user_id,
			body: row.body,
			status: row.status as CommentStatus,
			ipHash: row.ip_hash,
			userAgent: row.user_agent,
			moderationMetadata: row.moderation_metadata ? safeJsonParse(row.moderation_metadata) : null,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

function safeJsonParse(value: string): Record<string, unknown> | null {
	try {
		return JSON.parse(value) as Record<string, unknown>;
	} catch {
		return null;
	}
}
