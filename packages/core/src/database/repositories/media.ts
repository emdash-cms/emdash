import { sql, type ExpressionBuilder, type Kysely, type SqlBool } from "kysely";
import { ulid } from "ulidx";

import type { Database, MediaRow } from "../types.js";
import type { FindManyResult } from "./types.js";
import { encodeCursor, decodeCursor } from "./types.js";

/** Escape LIKE wildcard characters and the escape char itself in user-supplied values */
function escapeLike(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/**
 * Normalize a mimeType filter (string or array) into a clean string[].
 * Entries that are empty strings are dropped.
 */
function normalizeMimeFilter(input?: string | readonly string[]): string[] {
	if (!input) return [];
	const arr = Array.isArray(input) ? input : [input];
	return arr
		.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
		.map((entry) =>
			entry.endsWith("/") ? entry.toLowerCase() : entry.split(";")[0].trim().toLowerCase(),
		);
}

/**
 * Build a WHERE clause that matches `mime_type` against any of the given
 * filter entries — exact equality for full MIMEs, LIKE prefix for entries
 * ending in "/".
 */
function mimeMatchExpr(eb: ExpressionBuilder<Database, "media">, filters: string[]) {
	return eb.or(
		filters.map((entry) =>
			entry.endsWith("/")
				? sql<SqlBool>`mime_type LIKE ${`${escapeLike(entry)}%`} ESCAPE '\\'`
				: eb("mime_type", "=", entry),
		),
	);
}

export type MediaStatus = "pending" | "ready" | "failed";

export interface MediaItem {
	id: string;
	filename: string;
	mimeType: string;
	size: number | null;
	width: number | null;
	height: number | null;
	alt: string | null;
	caption: string | null;
	storageKey: string;
	status: MediaStatus;
	contentHash: string | null;
	blurhash: string | null;
	dominantColor: string | null;
	createdAt: string;
	authorId: string | null;
}

export interface CreateMediaInput {
	filename: string;
	mimeType: string;
	size?: number;
	width?: number;
	height?: number;
	alt?: string;
	caption?: string;
	storageKey: string;
	contentHash?: string;
	blurhash?: string;
	dominantColor?: string;
	status?: MediaStatus;
	authorId?: string;
}

export interface FindManyMediaOptions {
	limit?: number;
	cursor?: string;
	/** Filter by MIME type. Pass a string for a single prefix/exact, or an array to match any. Strings ending with "/" are treated as LIKE prefix matches; others are exact equality. */
	mimeType?: string | readonly string[];
	status?: MediaStatus | "all"; // Filter by status, defaults to "ready"
	/** Case-insensitive substring matched against the filename (covers filename and extension). */
	q?: string;
}

const UPLOAD_ATTEMPT_CLEANUP_AGE_MS = 60 * 60 * 1000;
const UPLOAD_ATTEMPT_CLEANUP_BATCH_SIZE = 100;

/**
 * Media repository for database operations
 */
export class MediaRepository {
	constructor(private db: Kysely<Database>) {}

	/**
	 * Create a new media item
	 */
	async create(input: CreateMediaInput): Promise<MediaItem> {
		const id = ulid();
		const now = new Date().toISOString();

		const row: Omit<MediaRow, "rowid"> = {
			id,
			filename: input.filename,
			mime_type: input.mimeType,
			size: input.size ?? null,
			width: input.width ?? null,
			height: input.height ?? null,
			alt: input.alt ?? null,
			caption: input.caption ?? null,
			storage_key: input.storageKey,
			content_hash: input.contentHash ?? null,
			blurhash: input.blurhash ?? null,
			dominant_color: input.dominantColor ?? null,
			status: input.status ?? "ready",
			created_at: now,
			author_id: input.authorId ?? null,
		};

		await this.db.insertInto("media").values(row).execute();

		return this.rowToItem(row);
	}

	/**
	 * Create a pending media item (for signed URL upload flow)
	 */
	async createPending(input: {
		filename: string;
		mimeType: string;
		size?: number;
		storageKey: string;
		contentHash?: string;
		authorId?: string;
	}): Promise<MediaItem> {
		return this.create({
			...input,
			status: "pending",
		});
	}

	async createUploadAttempt(mediaId: string, storageKey: string): Promise<void> {
		const now = new Date().toISOString();
		await this.db
			.insertInto("_emdash_media_upload_attempts")
			.values({
				media_id: mediaId,
				storage_key: storageKey,
				status: "active",
				created_at: now,
				updated_at: now,
			})
			.execute();
	}

	async hasUploadAttempt(storageKey: string): Promise<boolean> {
		const row = await this.db
			.selectFrom("_emdash_media_upload_attempts")
			.select("storage_key")
			.where("storage_key", "=", storageKey)
			.executeTakeFirst();
		return row !== undefined;
	}

	async claimUploadAttemptForCleanup(storageKey: string): Promise<boolean> {
		const result = await this.db
			.updateTable("_emdash_media_upload_attempts")
			.set({ status: "cleanup", updated_at: new Date().toISOString() })
			.where("storage_key", "=", storageKey)
			.where((eb) =>
				eb.not(
					eb.exists(
						eb
							.selectFrom("media")
							.select("media.id")
							.whereRef("media.storage_key", "=", "_emdash_media_upload_attempts.storage_key"),
					),
				),
			)
			.executeTakeFirst();

		return Number(result.numUpdatedRows ?? 0) > 0;
	}

	async deleteUploadAttempt(storageKey: string): Promise<void> {
		await this.db
			.deleteFrom("_emdash_media_upload_attempts")
			.where("storage_key", "=", storageKey)
			.execute();
	}

	async deleteCompletedUploadAttempts(): Promise<number> {
		const result = await this.db
			.deleteFrom("_emdash_media_upload_attempts")
			.where((eb) =>
				eb.exists(
					eb
						.selectFrom("media")
						.select("media.id")
						.whereRef("media.id", "=", "_emdash_media_upload_attempts.media_id")
						.whereRef("media.storage_key", "=", "_emdash_media_upload_attempts.storage_key")
						.where("media.status", "=", "ready"),
				),
			)
			.executeTakeFirst();
		return Number(result.numDeletedRows ?? 0);
	}

	async findUploadAttemptsForCleanup(
		maxAgeMs: number = UPLOAD_ATTEMPT_CLEANUP_AGE_MS,
		limit: number = UPLOAD_ATTEMPT_CLEANUP_BATCH_SIZE,
	): Promise<string[]> {
		const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
		const rows = await this.db
			.selectFrom("_emdash_media_upload_attempts")
			.select("storage_key")
			.where((eb) => eb.or([eb("status", "=", "cleanup"), eb("created_at", "<", cutoff)]))
			.where((eb) =>
				eb.not(
					eb.exists(
						eb
							.selectFrom("media")
							.select("media.id")
							.whereRef("media.storage_key", "=", "_emdash_media_upload_attempts.storage_key"),
					),
				),
			)
			.orderBy("created_at", "asc")
			.limit(limit)
			.execute();

		return rows.map((row) => row.storage_key);
	}

	async publishPendingStorageKey(
		id: string,
		expectedStorageKey: string,
		storageKey: string,
		contentHash?: string,
	): Promise<boolean> {
		const result = await this.db
			.updateTable("media")
			.set({
				storage_key: storageKey,
				...(contentHash !== undefined ? { content_hash: contentHash } : {}),
			})
			.where("id", "=", id)
			.where("status", "=", "pending")
			.where("storage_key", "=", expectedStorageKey)
			.where((eb) =>
				eb.exists(
					eb
						.selectFrom("_emdash_media_upload_attempts")
						.select("storage_key")
						.where("media_id", "=", id)
						.where("storage_key", "=", storageKey)
						.where("status", "=", "active"),
				),
			)
			.executeTakeFirst();

		return Number(result.numUpdatedRows ?? 0) > 0;
	}

	/**
	 * Confirm upload (mark as ready)
	 */
	async confirmUpload(
		id: string,
		metadata?: {
			width?: number;
			height?: number;
			size?: number;
			blurhash?: string;
			dominantColor?: string;
			contentHash?: string | null;
		},
		expectedStorageKey?: string,
	): Promise<MediaItem | null> {
		const updates: Partial<MediaRow> = {
			status: "ready",
		};
		if (metadata?.width !== undefined) updates.width = metadata.width;
		if (metadata?.height !== undefined) updates.height = metadata.height;
		if (metadata?.size !== undefined) updates.size = metadata.size;
		if (metadata?.blurhash !== undefined) updates.blurhash = metadata.blurhash;
		if (metadata?.dominantColor !== undefined) updates.dominant_color = metadata.dominantColor;
		if (metadata?.contentHash !== undefined) updates.content_hash = metadata.contentHash;

		let query = this.db
			.updateTable("media")
			.set(updates)
			.where("id", "=", id)
			.where("status", "=", "pending");
		if (expectedStorageKey !== undefined) {
			query = query.where("storage_key", "=", expectedStorageKey);
		}

		const row = await query.returningAll().executeTakeFirst();

		return row ? this.rowToItem(row) : null;
	}

	/**
	 * Mark upload as failed
	 */
	async markFailed(id: string, expectedStorageKey?: string): Promise<MediaItem | null> {
		let query = this.db.updateTable("media").set({ status: "failed" }).where("id", "=", id);
		if (expectedStorageKey !== undefined) {
			query = query.where("status", "=", "pending").where("storage_key", "=", expectedStorageKey);
		}

		const row = await query.returningAll().executeTakeFirst();
		return row ? this.rowToItem(row) : null;
	}

	/**
	 * Find media by ID
	 */
	async findById(id: string): Promise<MediaItem | null> {
		const row = await this.db
			.selectFrom("media")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();

		return row ? this.rowToItem(row) : null;
	}

	/**
	 * Find media by filename
	 * Useful for idempotent imports
	 */
	async findByFilename(filename: string): Promise<MediaItem | null> {
		const row = await this.db
			.selectFrom("media")
			.selectAll()
			.where("filename", "=", filename)
			.executeTakeFirst();

		return row ? this.rowToItem(row) : null;
	}

	/**
	 * Find media by content hash
	 * Used for deduplication - same content = same hash
	 */
	async findByContentHash(contentHash: string): Promise<MediaItem | null> {
		const row = await this.db
			.selectFrom("media")
			.selectAll()
			.where("content_hash", "=", contentHash)
			.where("status", "=", "ready")
			.executeTakeFirst();

		return row ? this.rowToItem(row) : null;
	}

	/**
	 * Find many media items with cursor pagination
	 *
	 * Uses keyset pagination (cursor-based) for consistent results.
	 * The cursor encodes the created_at and id of the last item.
	 */
	async findMany(options: FindManyMediaOptions = {}): Promise<FindManyResult<MediaItem>> {
		const limit = Math.min(options.limit || 50, 100);

		let query = this.db
			.selectFrom("media")
			.selectAll()
			.orderBy("created_at", "desc")
			.orderBy("id", "desc")
			.limit(limit + 1);

		// Handle cursor-based pagination — throws on invalid cursor.
		if (options.cursor) {
			const { orderValue: createdAt, id: cursorId } = decodeCursor(options.cursor);

			// Keyset pagination: get items where (created_at, id) < cursor
			query = query.where((eb) =>
				eb.or([
					eb("created_at", "<", createdAt),
					eb.and([eb("created_at", "=", createdAt), eb("id", "<", cursorId)]),
				]),
			);
		}

		const mimeFilters = normalizeMimeFilter(options.mimeType);
		if (mimeFilters.length > 0) {
			query = query.where((eb) => mimeMatchExpr(eb, mimeFilters));
		}

		// Case-insensitive filename substring search (also matches extensions).
		// LIKE wildcards in the term are escaped so they're treated literally.
		const term = options.q?.trim();
		if (term) {
			const pattern = `%${escapeLike(term)}%`;
			query = query.where(
				sql<string>`lower(filename)`,
				"like",
				sql<string>`lower(${pattern}) escape '\\'`,
			);
		}

		// Default to only showing ready items
		if (options.status !== "all") {
			query = query.where("status", "=", options.status ?? "ready");
		}

		const rows = await query.execute();

		const hasMore = rows.length > limit;
		const items = rows.slice(0, limit).map((row) => this.rowToItem(row));

		let nextCursor: string | undefined;
		if (hasMore && items.length > 0) {
			const lastItem = items.at(-1)!;
			nextCursor = encodeCursor(lastItem.createdAt, lastItem.id);
		}

		return { items, nextCursor };
	}

	/**
	 * Update media metadata
	 */
	async update(
		id: string,
		input: Partial<Pick<CreateMediaInput, "alt" | "caption" | "width" | "height">>,
	): Promise<MediaItem | null> {
		const existing = await this.findById(id);
		if (!existing) {
			return null;
		}

		const updates: Partial<MediaRow> = {};
		if (input.alt !== undefined) updates.alt = input.alt;
		if (input.caption !== undefined) updates.caption = input.caption;
		if (input.width !== undefined) updates.width = input.width;
		if (input.height !== undefined) updates.height = input.height;

		if (Object.keys(updates).length > 0) {
			await this.db.updateTable("media").set(updates).where("id", "=", id).execute();
		}

		return this.findById(id);
	}

	/**
	 * Delete media item
	 */
	async deleteWithStorageKey(id: string): Promise<string | null> {
		const deleted = await this.db
			.deleteFrom("media")
			.where("id", "=", id)
			.returning("storage_key")
			.executeTakeFirst();
		if (deleted) return deleted.storage_key;
		return null;
	}

	async delete(id: string): Promise<boolean> {
		return (await this.deleteWithStorageKey(id)) !== null;
	}

	/**
	 * Count media items
	 */
	async count(mimeType?: string | readonly string[]): Promise<number> {
		const filters = normalizeMimeFilter(mimeType);
		let query = this.db.selectFrom("media").select((eb) => eb.fn.count<number>("id").as("count"));

		if (filters.length > 0) {
			query = query.where((eb) => mimeMatchExpr(eb, filters));
		}

		const result = await query.executeTakeFirst();
		return Number(result?.count || 0);
	}

	/**
	 * Delete pending uploads older than the given age.
	 * Pending uploads that were never confirmed indicate abandoned upload flows.
	 *
	 * Returns the storage keys of deleted rows so callers can remove the
	 * corresponding files from object storage.
	 */
	async cleanupPendingUploads(maxAgeMs: number = 60 * 60 * 1000): Promise<string[]> {
		const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

		const rows = await this.db
			.deleteFrom("media")
			.where("status", "=", "pending")
			.where("created_at", "<", cutoff)
			.returning("storage_key")
			.execute();

		return rows.map((r) => r.storage_key);
	}

	/**
	 * Convert database row to MediaItem
	 */
	private rowToItem(row: MediaRow): MediaItem {
		return {
			id: row.id,
			filename: row.filename,
			mimeType: row.mime_type,
			size: row.size,
			width: row.width,
			height: row.height,
			alt: row.alt,
			caption: row.caption,
			storageKey: row.storage_key,
			contentHash: row.content_hash,
			blurhash: row.blurhash,
			dominantColor: row.dominant_color,
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- DB stores string; validated at insert but linter can't follow
			status: row.status as MediaStatus,
			createdAt: row.created_at,
			authorId: row.author_id,
		};
	}
}
