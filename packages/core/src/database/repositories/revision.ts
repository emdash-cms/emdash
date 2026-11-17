import { sql, type Insertable, type Kysely, type Selectable } from "kysely";
import { B32_CHARACTERS, decodeTime, encodeTime, monotonicFactory, ULID_REGEX } from "ulidx";

import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { ContentDatetimeNormalizer, type DatetimeContextCache } from "../content-datetime.js";
import type { Database, RevisionTable } from "../types.js";
import { validateIdentifier } from "../validate.js";

const monotonic = monotonicFactory();

export function createRevisionId(): string {
	return monotonic();
}

/**
 * The id of an entry's starting revision. Every save of the entry derives the same id, so
 * overlapping first saves write the row once. Its time is just before the entry was created,
 * so it sorts before every other revision of the entry.
 */
export function startingRevisionId(collection: string, entryId: string, createdAt: string): string {
	const created = ULID_REGEX.test(entryId) ? decodeTime(entryId) : Date.parse(createdAt);
	const time = Number.isFinite(created) ? Math.max(created - 1, 0) : 0;
	let hash = 0xcbf29ce484222325n;
	let suffix = "";
	for (const char of `${collection}/${entryId}`) {
		hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0)!)) * 0x100000001b3n);
	}
	for (let i = 0; i < 16; i++) {
		hash = BigInt.asUintN(64, (hash ^ BigInt(i)) * 0x100000001b3n);
		suffix += B32_CHARACTERS[Number(hash >> 59n)];
	}
	return encodeTime(time, 10) + suffix;
}

export interface Revision {
	id: string;
	collection: string;
	entryId: string;
	data: Record<string, unknown>;
	authorId: string | null;
	createdAt: string;
}

export type RevisionKind = "autosave" | "recovery";

/** What kind of save wrote a revision, and who edited it. */
export interface RevisionCredit {
	/** `null` for a kept revision. */
	kind: RevisionKind | null;
	/**
	 * Users who edited the revision since the one before it, latest first. `null` means its author
	 * alone.
	 */
	editedBy: string[] | null;
}

export interface RevisionAuthor {
	id: string;
	/** `null` when the account has no display name. */
	name: string | null;
}

export interface RevisionWithAuthor extends Revision {
	/** `null` when no author was recorded or the account no longer exists. */
	author: RevisionAuthor | null;
	/**
	 * Everyone who edited the revision since the one before it, latest first. An entry is `null`
	 * when the account no longer exists. `null` means its author alone.
	 */
	editedBy: Array<RevisionAuthor | null> | null;
}

export interface CreateRevisionInput {
	collection: string;
	entryId: string;
	data: Record<string, unknown>;
	authorId?: string;
	/** Absent or `null` for a kept revision. */
	kind?: RevisionKind | null;
	/** Users whose edits the revision holds, latest first. None means the author alone. */
	editedBy?: readonly string[] | null;
}

const EDITOR_SETS_PAGE = 100;

export function normalizeRevisionLimit(value: unknown): number {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return 50;
	return Math.max(1, Math.min(Math.trunc(numeric), 100));
}

/**
 * Revision repository for version history
 *
 * Each revision stores a JSON snapshot of the content at a point in time.
 * Used when collection has `supports: ["revisions"]` enabled.
 */
export class RevisionRepository {
	private readonly datetimes: ContentDatetimeNormalizer;

	constructor(
		private db: Kysely<Database>,
		datetimeContexts?: DatetimeContextCache,
	) {
		this.datetimes = new ContentDatetimeNormalizer(db, datetimeContexts);
	}

	/**
	 * Create a new revision
	 */
	async create(input: CreateRevisionInput): Promise<Revision> {
		const id = createRevisionId();
		const data =
			input.kind === "recovery"
				? input.data
				: await this.datetimes.normalizeData(input.collection, input.data);

		const row: Insertable<RevisionTable> = {
			id,
			collection: input.collection,
			entry_id: input.entryId,
			data: JSON.stringify(data),
			author_id: input.authorId ?? null,
			kind: input.kind ?? null,
			edited_by: input.editedBy?.length ? JSON.stringify(input.editedBy) : null,
		};

		await this.db.insertInto("revisions").values(row).execute();

		const revision = await this.findById(id);
		if (!revision) {
			throw new Error("Failed to create revision");
		}

		await this.queuePruning(input.collection, input.entryId, id);

		return revision;
	}

	/**
	 * Write a revision under a given id unless one with that id already exists.
	 */
	async createIfMissing(input: CreateRevisionInput & { id: string }): Promise<void> {
		const data = await this.datetimes.normalizeData(input.collection, input.data);
		await this.db
			.insertInto("revisions")
			.values({
				id: input.id,
				collection: input.collection,
				entry_id: input.entryId,
				data: JSON.stringify(data),
				author_id: input.authorId ?? null,
			})
			.onConflict((conflict) => conflict.column("id").doNothing())
			.execute();
	}

	async queuePruning(collection: string, entryId: string, revisionId: string): Promise<void> {
		try {
			await this.db
				.insertInto("_emdash_revision_prune_queue")
				.values({
					collection,
					entry_id: entryId,
					revision_id: revisionId,
				})
				.onConflict((conflict) =>
					conflict.columns(["collection", "entry_id"]).doUpdateSet({ revision_id: revisionId }),
				)
				.execute();
		} catch (error) {
			console.error(
				`[revisions] Failed to queue revision pruning for ${collection}/${entryId}:`,
				error,
			);
		}
	}

	/**
	 * Find revision by ID
	 */
	async findById(id: string): Promise<Revision | null> {
		const row = await this.findRow(id);
		return row ? this.normalizeRow(row) : null;
	}

	/** Find a draft revision a save builds on, with what kind of save wrote it and who edited it. */
	async findDraftBase(id: string): Promise<(Revision & RevisionCredit) | null> {
		const row = await this.findRow(id);
		if (!row) return null;
		return {
			...(await this.normalizeRow(row)),
			kind: parseRevisionKind(row.kind),
			editedBy: parseEditedBy(row.edited_by),
		};
	}

	private findRow(id: string) {
		return this.db.selectFrom("revisions").selectAll().where("id", "=", id).executeTakeFirst();
	}

	/** Shallow-merge `patch` into a stored revision's data. */
	async mergeData(id: string, patch: Record<string, unknown>): Promise<void> {
		const row = await this.db
			.selectFrom("revisions")
			.select("data")
			.where("id", "=", id)
			.executeTakeFirst();
		if (!row) return;
		const data: Record<string, unknown> = { ...JSON.parse(row.data), ...patch };
		await this.db
			.updateTable("revisions")
			.set({ data: JSON.stringify(data) })
			.where("id", "=", id)
			.execute();
	}

	/**
	 * Get all revisions for an entry (newest first)
	 *
	 * Orders by monotonic ULID (descending). The monotonic factory
	 * guarantees strictly increasing IDs even within the same millisecond.
	 */
	async findByEntry(
		collection: string,
		entryId: string,
		options: { limit?: number } = {},
	): Promise<RevisionWithAuthor[]> {
		let query = this.db
			.selectFrom("revisions")
			.leftJoin("users", "users.id", "revisions.author_id")
			.selectAll("revisions")
			.select(["users.id as author_user_id", "users.name as author_name"])
			.where("revisions.collection", "=", collection)
			.where("revisions.entry_id", "=", entryId)
			.orderBy("revisions.id", "desc");

		if (options.limit) {
			query = query.limit(options.limit);
		}

		const rows = await query.execute();
		const data = await this.normalizeRows(collection, rows);
		const editorIds = rows.map((row) => parseEditedBy(row.edited_by));
		const editors = await this.findAuthors(editorIds.flatMap((ids) => ids ?? []));
		return rows.map((row, index) => {
			const normalized = data[index];
			if (!normalized) throw new Error("Failed to normalize revision data");
			const ids = editorIds[index];
			return {
				...this.rowToRevision(row, normalized),
				author: row.author_user_id
					? { id: row.author_user_id, name: row.author_name?.trim() || null }
					: null,
				editedBy: ids ? ids.map((id) => editors.get(id) ?? null) : null,
			};
		});
	}

	/**
	 * Everyone the entry's revisions newer than `sinceId` credit, newest first and once each, or
	 * everyone its revisions credit when `sinceId` is `null`. A revision credits its editors, or its
	 * author when none are recorded; one that records no one credits no one. An entry is `null` for
	 * an account that no longer exists. Revisions that credit the same people are read as one set,
	 * {@link EDITOR_SETS_PAGE} sets per query.
	 */
	async findEditorsSince(
		collection: string,
		entryId: string,
		sinceId: string | null,
	): Promise<Array<RevisionAuthor | null>> {
		const ids = new Set<string>();
		let before: string | null = null;
		for (;;) {
			let query = this.db
				.selectFrom("revisions")
				.select((eb) => ["author_id", "edited_by", eb.fn.max("id").as("newest")])
				.where("collection", "=", collection)
				.where("entry_id", "=", entryId)
				.groupBy(["author_id", "edited_by"])
				.orderBy("newest", "desc")
				.limit(EDITOR_SETS_PAGE);
			if (sinceId) query = query.where("id", ">", sinceId);
			if (before) query = query.having((eb) => eb(eb.fn.max("id"), "<", before));

			// oxlint-disable-next-line no-await-in-loop -- each page starts below the last one
			const rows = await query.execute();
			for (const row of rows) {
				for (const id of parseEditedBy(row.edited_by) ?? (row.author_id ? [row.author_id] : [])) {
					ids.add(id);
				}
			}
			const last = rows.at(-1);
			if (rows.length < EDITOR_SETS_PAGE || !last) break;
			before = last.newest;
		}
		const authors = await this.findAuthors([...ids]);
		return Array.from(ids, (id) => authors.get(id) ?? null);
	}

	/** The accounts among `userIds` that still exist, keyed by ID. */
	private async findAuthors(userIds: readonly string[]): Promise<Map<string, RevisionAuthor>> {
		const authors = new Map<string, RevisionAuthor>();
		for (const batch of chunks([...new Set(userIds)], SQL_BATCH_SIZE)) {
			const users = await this.db
				.selectFrom("users")
				.select(["id", "name"])
				.where("id", "in", batch)
				.execute();
			for (const user of users) {
				authors.set(user.id, { id: user.id, name: user.name?.trim() || null });
			}
		}
		return authors;
	}

	async findByIds(collection: string, ids: string[]): Promise<Revision[]> {
		const revisions: Revision[] = [];
		for (const batch of chunks([...new Set(ids)], SQL_BATCH_SIZE)) {
			const rows = await this.db
				.selectFrom("revisions")
				.selectAll()
				.where("collection", "=", collection)
				.where("id", "in", batch)
				.execute();
			const data = await this.datetimes.normalizeDataMany(
				collection,
				rows.map((row) => JSON.parse(row.data)),
			);
			for (const [index, row] of rows.entries()) {
				const normalized = data[index];
				if (!normalized) throw new Error("Failed to normalize revision data");
				revisions.push(this.rowToRevision(row, normalized));
			}
		}
		return revisions;
	}

	/** Read revisions only when the owning content row is visible in the same statement snapshot. */
	async findVisibleByEntry(
		collection: string,
		entryId: string,
		options: { limit?: number } = {},
	): Promise<Revision[]> {
		validateIdentifier(collection, "collection");
		const tableName = `ec_${collection}`;
		const limit = normalizeRevisionLimit(options.limit);
		const result = await sql<Selectable<RevisionTable>>`
			SELECT revisions.* FROM revisions
			WHERE revisions.collection = ${collection}
			AND revisions.entry_id = ${entryId}
			AND EXISTS (
				SELECT 1 FROM ${sql.ref(tableName)} AS content
				WHERE content.id = ${entryId}
				AND content.deleted_at IS NULL
			)
			ORDER BY revisions.id DESC
			LIMIT ${limit}
		`.execute(this.db);
		const data = await this.normalizeRows(collection, result.rows);
		return result.rows.map((row, index) => {
			const normalized = data[index];
			if (!normalized) throw new Error("Failed to normalize revision data");
			return this.rowToRevision(row, normalized);
		});
	}

	/** Read one revision only when its owning content row is visible in the same statement snapshot. */
	async findVisibleById(
		collection: string,
		entryId: string,
		revisionId: string,
	): Promise<Revision | null> {
		validateIdentifier(collection, "collection");
		const tableName = `ec_${collection}`;
		const result = await sql<Selectable<RevisionTable>>`
			SELECT revisions.* FROM revisions
			WHERE revisions.id = ${revisionId}
			AND revisions.collection = ${collection}
			AND revisions.entry_id = ${entryId}
			AND EXISTS (
				SELECT 1 FROM ${sql.ref(tableName)} AS content
				WHERE content.id = ${entryId}
				AND content.deleted_at IS NULL
			)
			LIMIT 1
		`.execute(this.db);
		const row = result.rows[0];
		return row ? this.normalizeRow(row) : null;
	}

	/**
	 * Get the most recent revision for an entry
	 */
	async findLatest(collection: string, entryId: string): Promise<Revision | null> {
		const row = await this.db
			.selectFrom("revisions")
			.selectAll()
			.where("collection", "=", collection)
			.where("entry_id", "=", entryId)
			.orderBy("id", "desc")
			.limit(1)
			.executeTakeFirst();

		return row ? this.normalizeRow(row) : null;
	}

	/**
	 * Count revisions for an entry
	 */
	async countByEntry(collection: string, entryId: string): Promise<number> {
		const result = await this.db
			.selectFrom("revisions")
			.select((eb) => eb.fn.count("id").as("count"))
			.where("collection", "=", collection)
			.where("entry_id", "=", entryId)
			.executeTakeFirst();

		return Number(result?.count || 0);
	}

	/**
	 * Delete all revisions for an entry (use when entry is deleted)
	 */
	async deleteByEntry(collection: string, entryId: string): Promise<number> {
		const result = await this.db
			.deleteFrom("revisions")
			.where("collection", "=", collection)
			.where("entry_id", "=", entryId)
			.executeTakeFirst();

		try {
			await this.db
				.deleteFrom("_emdash_revision_prune_queue")
				.where("collection", "=", collection)
				.where("entry_id", "=", entryId)
				.execute();
		} catch (error) {
			console.error(
				`[revisions] Failed to clear queued revision pruning for ${collection}/${entryId}:`,
				error,
			);
		}

		return Number(result.numDeletedRows ?? 0);
	}

	/**
	 * Delete old revisions, keeping the most recent N
	 */
	async pruneOldRevisions(
		collection: string,
		entryId: string,
		keepCount: number,
		throughRevisionId?: string,
	): Promise<number> {
		validateIdentifier(collection, "collection");
		const tableName = `ec_${collection}`;
		let keepQuery = this.db
			.selectFrom("revisions")
			.select("id")
			.where("collection", "=", collection)
			.where("entry_id", "=", entryId)
			.orderBy("created_at", "desc")
			.orderBy("id", "desc") // ULID tiebreaker
			.limit(keepCount);

		if (throughRevisionId) {
			keepQuery = keepQuery.where("id", "<=", throughRevisionId);
		}

		const keep = await keepQuery.execute();

		const keepIds = keep.map((r) => r.id);

		if (keepIds.length === 0) return 0;
		const revisionBoundary = throughRevisionId ? sql`AND id <= ${throughRevisionId}` : sql``;

		const result = await sql`
			DELETE FROM revisions
			WHERE collection = ${collection}
			AND entry_id = ${entryId}
			${revisionBoundary}
			AND id NOT IN (${sql.join(keepIds.map((id) => sql`${id}`))})
			AND NOT EXISTS (
				SELECT 1 FROM ${sql.ref(tableName)} AS content
				WHERE content.live_revision_id = revisions.id
				OR content.draft_revision_id = revisions.id
			)
		`.execute(this.db);

		return Number(result.numAffectedRows ?? 0);
	}

	async pruneQueuedEntry(
		collection: string,
		entryId: string,
		queuedRevisionId: string,
		keepCount: number,
	): Promise<number> {
		const pruned = await this.pruneOldRevisions(collection, entryId, keepCount, queuedRevisionId);
		await this.db
			.deleteFrom("_emdash_revision_prune_queue")
			.where("collection", "=", collection)
			.where("entry_id", "=", entryId)
			.where("revision_id", "=", queuedRevisionId)
			.execute();
		return pruned;
	}

	/**
	 * With `autosaveOnly`, deletes the revision only while it is still an autosave, so one marked
	 * kept after the caller decided to replace it survives.
	 */
	async deleteIfUnreferenced(
		collection: string,
		entryId: string,
		revisionId: string,
		options: { autosaveOnly?: boolean } = {},
	): Promise<boolean> {
		validateIdentifier(collection, "collection");
		const tableName = `ec_${collection}`;
		const result = await sql`
			DELETE FROM revisions
			WHERE id = ${revisionId}
			AND collection = ${collection}
			AND entry_id = ${entryId}
			${options.autosaveOnly ? sql`AND kind = 'autosave'` : sql``}
			AND NOT EXISTS (
				SELECT 1 FROM ${sql.ref(tableName)} AS content
				WHERE content.live_revision_id = revisions.id
				OR content.draft_revision_id = revisions.id
			)
		`.execute(this.db);
		return (result.numAffectedRows ?? 0n) > 0n;
	}

	/**
	 * Convert database row to Revision object
	 */
	private async normalizeRow(row: {
		id: string;
		collection: string;
		entry_id: string;
		data: string;
		kind: string | null;
		author_id: string | null;
		created_at: string;
	}): Promise<Revision> {
		const [data] = await this.normalizeRows(row.collection, [row]);
		return this.rowToRevision(row, data ?? {});
	}

	/** Recovery revisions keep their data as sent; restoring one validates it. */
	private async normalizeRows(
		collection: string,
		rows: readonly { data: string; kind: string | null }[],
	): Promise<Record<string, unknown>[]> {
		const data: Record<string, unknown>[] = rows.map((row) => JSON.parse(row.data));
		const kept = rows.flatMap((row, index) => (row.kind === "recovery" ? [] : [index]));
		const normalized = await this.datetimes.normalizeDataMany(
			collection,
			kept.map((index) => data[index]),
		);
		for (const [position, index] of kept.entries()) data[index] = normalized[position];
		return data;
	}

	private rowToRevision(
		row: {
			id: string;
			collection: string;
			entry_id: string;
			data: string;
			author_id: string | null;
			created_at: string;
		},
		data: Record<string, unknown>,
	): Revision {
		return {
			id: row.id,
			collection: row.collection,
			entryId: row.entry_id,
			data,
			authorId: row.author_id,
			createdAt: row.created_at,
		};
	}
}

function parseRevisionKind(value: string | null): RevisionKind | null {
	return value === "autosave" || value === "recovery" ? value : null;
}

function parseEditedBy(value: string | null): string[] | null {
	if (value === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	return Array.isArray(parsed) &&
		parsed.length > 0 &&
		parsed.every((id): id is string => typeof id === "string")
		? parsed
		: null;
}
