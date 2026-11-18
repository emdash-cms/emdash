import { sql, type Kysely, type Selectable, type SelectQueryBuilder } from "kysely";
import { monotonicFactory } from "ulidx";

import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { executeAtomicBatchIfSupported } from "../dialect-helpers.js";
import type { Database, EditorialThreadTable } from "../types.js";
import { validateIdentifier } from "../validate.js";
import {
	ContentMutationConflictError,
	decodeCursor,
	encodeCursor,
	type FindManyResult,
} from "./types.js";

export type EditorialAnchor =
	| { type: "entry" }
	| { type: "field"; field: string }
	| { type: "block"; field: string; blockKey: string }
	| {
			type: "text";
			field: string;
			blockKey: string;
			start: number;
			end: number;
			quote: string;
			prefix: string;
			suffix: string;
	  };

export type EditorialAnchorState = "attached" | "orphaned";
export type EditorialThreadStatus = "open" | "resolved";

export interface EditorialPerson {
	id: string;
	name: string | null;
	avatarUrl: string | null;
}

export interface EditorialComment {
	id: string;
	threadId: string;
	/** `null` once the author's account is deleted. */
	author: EditorialPerson | null;
	/** Empty once the comment is deleted. */
	body: string;
	createdAt: string;
	editedAt: string | null;
	deletedAt: string | null;
}

export interface EditorialThread {
	id: string;
	collection: string;
	entryId: string;
	anchor: EditorialAnchor;
	anchorState: EditorialAnchorState;
	status: EditorialThreadStatus;
	createdBy: string | null;
	resolvedBy: EditorialPerson | null;
	resolvedAt: string | null;
	createdAt: string;
	updatedAt: string;
	comments: EditorialComment[];
}

/** A thread row without its comments, for permission checks before a write. */
export type EditorialThreadHead = Omit<EditorialThread, "comments" | "resolvedBy"> & {
	resolvedBy: string | null;
};

export interface EditorialCommentHead {
	id: string;
	threadId: string;
	authorId: string | null;
	body: string;
	deletedAt: string | null;
}

export interface EditorialAnchorUpdate {
	threadId: string;
	anchor: EditorialAnchor;
	anchorState: EditorialAnchorState;
}

interface ThreadRow {
	id: string;
	collection: string;
	entry_id: string;
	anchor: string;
	anchor_state: string;
	status: string;
	created_by: string | null;
	resolved_by: string | null;
	resolved_at: string | null;
	created_at: string;
	updated_at: string;
}

/**
 * Threads and comments are ordered by `(created_at, id)`. Monotonic IDs keep
 * rows that one process writes in the same millisecond in the order it wrote
 * them. Rows from different processes or isolates have no such order. The
 * factory lives on `globalThis` because Vite can load this module more than
 * once, and each copy would start its own sequence.
 */
const ULID_KEY = Symbol.for("emdash:editorial-thread-ulid");

function ulid(): string {
	const store = globalThis as typeof globalThis & {
		[ULID_KEY]?: ReturnType<typeof monotonicFactory>;
	};
	store[ULID_KEY] ??= monotonicFactory();
	return store[ULID_KEY]();
}

function parseAnchor(raw: string): EditorialAnchor {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- anchors are validated before they are stored
	return JSON.parse(raw) as EditorialAnchor;
}

function toHead(row: ThreadRow): EditorialThreadHead {
	return {
		id: row.id,
		collection: row.collection,
		entryId: row.entry_id,
		anchor: parseAnchor(row.anchor),
		anchorState: row.anchor_state === "orphaned" ? "orphaned" : "attached",
		status: row.status === "resolved" ? "resolved" : "open",
		createdBy: row.created_by,
		resolvedBy: row.resolved_by,
		resolvedAt: row.resolved_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function person(
	id: string | null,
	name: string | null | undefined,
	avatarUrl: string | null | undefined,
): EditorialPerson | null {
	if (!id || name === undefined) return null;
	return { id, name: name ?? null, avatarUrl: avatarUrl ?? null };
}

/**
 * Editorial threads and their comments. Threads belong to one per-locale entry
 * row and never touch the entry itself.
 */
export class EditorialThreadRepository {
	constructor(private db: Kysely<Database>) {}

	/**
	 * One page of an entry's threads, oldest first, each with its comments in
	 * order. Threads, comments and the people on them come from one query.
	 */
	async listForEntry(
		collection: string,
		entryId: string,
		options: { status?: EditorialThreadStatus; limit: number; cursor?: string },
	): Promise<FindManyResult<EditorialThread>> {
		let page = this.db
			.selectFrom("_emdash_editorial_threads")
			.selectAll()
			.where("collection", "=", collection)
			.where("entry_id", "=", entryId);
		if (options.status) page = page.where("status", "=", options.status);
		if (options.cursor) {
			const { orderValue, id } = decodeCursor(options.cursor);
			page = page.where((eb) =>
				eb.or([
					eb("created_at", ">", orderValue),
					eb.and([eb("created_at", "=", orderValue), eb("id", ">", id)]),
				]),
			);
		}
		const pageQuery = page
			.orderBy("created_at", "asc")
			.orderBy("id", "asc")
			.limit(options.limit + 1);

		const items = await this.withComments(pageQuery);
		if (items.length <= options.limit) return { items };
		items.length = options.limit;
		const last = items.at(-1)!;
		return { items, nextCursor: encodeCursor(last.createdAt, last.id) };
	}

	/** Thread with comments, or `null` when it doesn't exist. */
	async getThread(id: string): Promise<EditorialThread | null> {
		const [thread] = await this.withComments(
			this.db.selectFrom("_emdash_editorial_threads").selectAll().where("id", "=", id),
		);
		return thread ?? null;
	}

	/**
	 * Joins each thread from `threadQuery` to its comments and the people on
	 * them in one query, keeping `threadQuery`'s order.
	 */
	private async withComments(
		threadQuery: SelectQueryBuilder<
			Database,
			"_emdash_editorial_threads",
			Selectable<EditorialThreadTable>
		>,
	): Promise<EditorialThread[]> {
		const rows = await this.db
			.selectFrom(threadQuery.as("t"))
			.leftJoin("_emdash_editorial_comments as c", "c.thread_id", "t.id")
			.leftJoin("users as ca", "ca.id", "c.author_id")
			.leftJoin("users as ru", "ru.id", "t.resolved_by")
			.select([
				"t.id",
				"t.collection",
				"t.entry_id",
				"t.anchor",
				"t.anchor_state",
				"t.status",
				"t.created_by",
				"t.resolved_by",
				"t.resolved_at",
				"t.created_at",
				"t.updated_at",
				"c.id as comment_id",
				"c.author_id as comment_author_id",
				"c.body as comment_body",
				"c.created_at as comment_created_at",
				"c.edited_at as comment_edited_at",
				"c.deleted_at as comment_deleted_at",
				"ca.id as comment_author_found",
				"ca.name as comment_author_name",
				"ca.avatar_url as comment_author_avatar",
				"ru.id as resolver_found",
				"ru.name as resolver_name",
				"ru.avatar_url as resolver_avatar",
			])
			.orderBy("t.created_at", "asc")
			.orderBy("t.id", "asc")
			.orderBy("c.created_at", "asc")
			.orderBy("c.id", "asc")
			.execute();

		const threads = new Map<string, EditorialThread>();
		for (const row of rows) {
			let thread = threads.get(row.id);
			if (!thread) {
				const head = toHead(row);
				thread = {
					...head,
					resolvedBy: row.resolver_found
						? person(row.resolver_found, row.resolver_name, row.resolver_avatar)
						: null,
					comments: [],
				};
				threads.set(row.id, thread);
			}
			if (row.comment_id) {
				thread.comments.push({
					id: row.comment_id,
					threadId: row.id,
					author: row.comment_author_found
						? person(row.comment_author_found, row.comment_author_name, row.comment_author_avatar)
						: null,
					body: row.comment_body ?? "",
					createdAt: row.comment_created_at ?? row.created_at,
					editedAt: row.comment_edited_at ?? null,
					deletedAt: row.comment_deleted_at ?? null,
				});
			}
		}

		return [...threads.values()];
	}

	async findThread(id: string): Promise<EditorialThreadHead | null> {
		const row = await this.db
			.selectFrom("_emdash_editorial_threads")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		return row ? toHead(row) : null;
	}

	async findComment(id: string): Promise<EditorialCommentHead | null> {
		const row = await this.db
			.selectFrom("_emdash_editorial_comments")
			.select(["id", "thread_id", "author_id", "body", "deleted_at"])
			.where("id", "=", id)
			.executeTakeFirst();
		if (!row) return null;
		return {
			id: row.id,
			threadId: row.thread_id,
			authorId: row.author_id,
			body: row.body,
			deletedAt: row.deleted_at,
		};
	}

	/** IDs of everyone who has written a live comment on the thread. */
	async listCommentAuthors(threadId: string): Promise<string[]> {
		const rows = await this.db
			.selectFrom("_emdash_editorial_comments")
			.select("author_id")
			.distinct()
			.where("thread_id", "=", threadId)
			.where("deleted_at", "is", null)
			.where("author_id", "is not", null)
			.execute();
		return rows.flatMap((row) => (row.author_id ? [row.author_id] : []));
	}

	/**
	 * Creates a thread together with its first comment. Call it inside
	 * `withTransaction`, so both rows commit together where the database has
	 * transactions.
	 */
	async createThread(input: {
		collection: string;
		entryId: string;
		anchor: EditorialAnchor;
		createdBy: string;
		body: string;
		now: string;
	}): Promise<{ threadId: string; commentId: string }> {
		const threadId = ulid();
		const commentId = ulid();
		await this.db
			.insertInto("_emdash_editorial_threads")
			.values({
				id: threadId,
				collection: input.collection,
				entry_id: input.entryId,
				anchor: JSON.stringify(input.anchor),
				anchor_state: "attached",
				status: "open",
				created_by: input.createdBy,
				resolved_by: null,
				resolved_at: null,
				created_at: input.now,
				updated_at: input.now,
			})
			.execute();
		try {
			await this.db
				.insertInto("_emdash_editorial_comments")
				.values({
					id: commentId,
					thread_id: threadId,
					author_id: input.createdBy,
					body: input.body,
					created_at: input.now,
					edited_at: null,
					deleted_at: null,
				})
				.execute();
		} catch (error) {
			// Without a transaction, as on D1, the thread would stay behind with no comments.
			if (!this.db.isTransaction) {
				await this.db
					.deleteFrom("_emdash_editorial_threads")
					.where("id", "=", threadId)
					.execute()
					.catch(() => {});
			}
			throw error;
		}
		return { threadId, commentId };
	}

	/**
	 * Adds a reply, reopening the thread if it was resolved. Call it inside
	 * `withTransaction`, so the reply and the reopening commit together.
	 */
	async addComment(input: {
		threadId: string;
		authorId: string;
		body: string;
		now: string;
	}): Promise<string> {
		const id = ulid();
		await this.lockThread(input.threadId);
		await this.db
			.insertInto("_emdash_editorial_comments")
			.values({
				id,
				thread_id: input.threadId,
				author_id: input.authorId,
				body: input.body,
				created_at: input.now,
				edited_at: null,
				deleted_at: null,
			})
			.execute();
		await this.db
			.updateTable("_emdash_editorial_threads")
			.set({ status: "open", resolved_by: null, resolved_at: null, updated_at: input.now })
			.where("id", "=", input.threadId)
			.execute();
		return id;
	}

	async editComment(input: { commentId: string; threadId: string; body: string; now: string }) {
		await this.lockThread(input.threadId);
		const edited = await this.db
			.updateTable("_emdash_editorial_comments")
			.set({ body: input.body, edited_at: input.now })
			.where("id", "=", input.commentId)
			.where("thread_id", "=", input.threadId)
			.where("deleted_at", "is", null)
			.executeTakeFirst();
		if (Number(edited.numUpdatedRows) > 0) await this.touch(input.threadId, input.now);
	}

	/**
	 * Clears the comment's body and marks it deleted. When no live comment
	 * remains, the thread goes too. Returns whether the thread was deleted.
	 * Call it inside `withTransaction`.
	 */
	async deleteComment(input: {
		commentId: string;
		threadId: string;
		now: string;
	}): Promise<boolean> {
		await this.lockThread(input.threadId);
		const tombstoned = await this.db
			.updateTable("_emdash_editorial_comments")
			.set({ body: "", deleted_at: input.now })
			.where("id", "=", input.commentId)
			.where("thread_id", "=", input.threadId)
			.where("deleted_at", "is", null)
			.executeTakeFirst();
		if (Number(tombstoned.numUpdatedRows) === 0) return false;
		// Checking for live comments in the delete itself keeps a reply that lands
		// after the update from going with the thread.
		const deleted = await this.db
			.deleteFrom("_emdash_editorial_threads")
			.where("id", "=", input.threadId)
			.where(({ exists, not, selectFrom }) =>
				not(
					exists(
						selectFrom("_emdash_editorial_comments")
							.select("id")
							.where("thread_id", "=", input.threadId)
							.where("deleted_at", "is", null),
					),
				),
			)
			.executeTakeFirst();
		if (Number(deleted.numDeletedRows ?? 0) > 0) {
			await this.db
				.deleteFrom("_emdash_editorial_comments")
				.where("thread_id", "=", input.threadId)
				.execute();
			return true;
		}
		await this.touch(input.threadId, input.now);
		return false;
	}

	async setStatus(input: {
		threadId: string;
		status: EditorialThreadStatus;
		userId: string;
		now: string;
	}): Promise<void> {
		const resolved = input.status === "resolved";
		await this.db
			.updateTable("_emdash_editorial_threads")
			.set({
				status: input.status,
				resolved_by: resolved ? input.userId : null,
				resolved_at: resolved ? input.now : null,
				updated_at: input.now,
			})
			.where("id", "=", input.threadId)
			.execute();
	}

	/** The stored anchors of those of `threadIds` that are on the entry. */
	async findAnchors(
		collection: string,
		entryId: string,
		threadIds: string[],
	): Promise<Map<string, EditorialAnchor>> {
		const anchors = new Map<string, EditorialAnchor>();
		for (const batch of chunks([...new Set(threadIds)], SQL_BATCH_SIZE)) {
			// oxlint-disable-next-line no-await-in-loop -- batches stay within D1's bind-parameter limit
			const rows = await this.db
				.selectFrom("_emdash_editorial_threads")
				.select(["id", "anchor"])
				.where("collection", "=", collection)
				.where("entry_id", "=", entryId)
				.where("id", "in", batch)
				.execute();
			for (const row of rows) anchors.set(row.id, parseAnchor(row.anchor));
		}
		return anchors;
	}

	/**
	 * Stores new anchors for threads on one entry, while the entry is out of
	 * the trash and still has `expected`'s `version` and `updatedAt`. Updates
	 * naming a thread on another entry are ignored. Returns how many threads
	 * changed. Throws `ContentMutationConflictError` once the entry no longer
	 * matches. On D1 the check and every write run as one atomic batch; call it
	 * inside `withTransaction` so that elsewhere a conflict rolls back the
	 * anchors already stored.
	 */
	async updateAnchors(input: {
		collection: string;
		entryId: string;
		expected: { version: number; updatedAt: string };
		updates: EditorialAnchorUpdate[];
		now: string;
	}): Promise<number> {
		validateIdentifier(input.collection, "collection type");
		const currentEntry = sql<{ current: number }>`
			SELECT 1 AS current FROM ${sql.ref(`ec_${input.collection}`)}
			WHERE id = ${input.entryId}
			AND deleted_at IS NULL
			AND version = ${input.expected.version}
			AND updated_at = ${input.expected.updatedAt}
		`;
		const writes = input.updates.map((update) =>
			this.db
				.updateTable("_emdash_editorial_threads")
				.set({
					anchor: JSON.stringify(update.anchor),
					anchor_state: update.anchorState,
					updated_at: input.now,
				})
				.where("id", "=", update.threadId)
				.where("collection", "=", input.collection)
				.where("entry_id", "=", input.entryId)
				.where(sql<boolean>`EXISTS (${currentEntry})`)
				.returning("id"),
		);

		const batched = await executeAtomicBatchIfSupported(this.db, [currentEntry, ...writes]);
		if (batched) {
			if (batched[0]?.rows.length !== 1) throw new ContentMutationConflictError();
			return batched.slice(1).reduce((total, result) => total + result.rows.length, 0);
		}

		let updated = 0;
		for (const write of writes) {
			// oxlint-disable-next-line no-await-in-loop -- each row gets its own anchor value
			const changed = (await write.execute()).length;
			if (changed === 0) {
				// oxlint-disable-next-line no-await-in-loop -- tells a stale entry from a thread on another entry
				const stillCurrent = await currentEntry.execute(this.db);
				if (stillCurrent.rows.length === 0) throw new ContentMutationConflictError();
			}
			updated += changed;
		}
		return updated;
	}

	async deleteThread(threadId: string): Promise<void> {
		await this.db
			.deleteFrom("_emdash_editorial_comments")
			.where("thread_id", "=", threadId)
			.execute();
		await this.db.deleteFrom("_emdash_editorial_threads").where("id", "=", threadId).execute();
	}

	/**
	 * Deletes the thread only while every live comment on it is by `authorId`.
	 * Checking in the delete itself keeps a reply that lands meanwhile.
	 * Returns whether the thread was deleted. Call it inside `withTransaction`.
	 */
	async deleteThreadIfOnlyAuthor(threadId: string, authorId: string): Promise<boolean> {
		await this.lockThread(threadId);
		const deleted = await this.db
			.deleteFrom("_emdash_editorial_threads")
			.where("id", "=", threadId)
			.where(({ exists, not, selectFrom }) =>
				not(
					exists(
						selectFrom("_emdash_editorial_comments")
							.select("id")
							.where("thread_id", "=", threadId)
							.where("deleted_at", "is", null)
							.where((inner) =>
								inner.or([inner("author_id", "is", null), inner("author_id", "!=", authorId)]),
							),
					),
				),
			)
			.executeTakeFirst();
		if (Number(deleted.numDeletedRows ?? 0) === 0) return false;
		await this.db
			.deleteFrom("_emdash_editorial_comments")
			.where("thread_id", "=", threadId)
			.execute();
		return true;
	}

	async deleteForEntry(collection: string, entryId: string): Promise<void> {
		await this.deleteWhere(collection, entryId);
	}

	async deleteForCollection(collection: string): Promise<void> {
		await this.deleteWhere(collection);
	}

	private async deleteWhere(collection: string, entryId?: string): Promise<void> {
		await this.db
			.deleteFrom("_emdash_editorial_comments")
			.where((eb) => {
				let threads = eb
					.selectFrom("_emdash_editorial_threads")
					.select("id")
					.where("collection", "=", collection);
				if (entryId !== undefined) threads = threads.where("entry_id", "=", entryId);
				return eb("thread_id", "in", threads);
			})
			.execute();
		let threads = this.db
			.deleteFrom("_emdash_editorial_threads")
			.where("collection", "=", collection);
		if (entryId !== undefined) threads = threads.where("entry_id", "=", entryId);
		await threads.execute();
	}

	/**
	 * Takes the thread row's write lock, so concurrent transactions changing
	 * one thread's comments run one after another and each sees the comments
	 * the last one committed. SQLite already allows one writer at a time.
	 */
	private async lockThread(threadId: string): Promise<void> {
		await this.db
			.updateTable("_emdash_editorial_threads")
			.set((eb) => ({ updated_at: eb.ref("updated_at") }))
			.where("id", "=", threadId)
			.execute();
	}

	private async touch(threadId: string, now: string): Promise<void> {
		await this.db
			.updateTable("_emdash_editorial_threads")
			.set({ updated_at: now })
			.where("id", "=", threadId)
			.execute();
	}
}
