import { sql, type Kysely, type SqlBool } from "kysely";
import { ulid } from "ulidx";

import type { Database, MediaRow } from "../types.js";
import type { FindManyResult } from "./types.js";
import { encodeCursor, decodeCursor } from "./types.js";

/** Escape LIKE wildcard characters and the escape char itself in user-supplied values */
function escapeLike(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
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
	mimeType?: string; // Filter by mime type prefix, e.g., "image/"
	status?: MediaStatus | "all"; // Filter by status, defaults to "ready"
}

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

		return this.rowToItem(row as MediaRow);
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

	/**
	 * Confirm upload (mark as ready)
	 */
	async confirmUpload(
		id: string,
		metadata?: { width?: number; height?: number; size?: number },
	): Promise<MediaItem | null> {
		const existing = await this.findById(id);
		if (!existing) {
			return null;
		}

		const updates: Partial<MediaRow> = {
			status: "ready",
		};
		if (metadata?.width !== undefined) updates.width = metadata.width;
		if (metadata?.height !== undefined) updates.height = metadata.height;
		if (metadata?.size !== undefined) updates.size = metadata.size;

		await this.db.updateTable("media").set(updates).where("id", "=", id).execute();

		return this.findById(id);
	}

	/**
	 * Mark upload as failed
	 */
	async markFailed(id: string): Promise<MediaItem | null> {
		const existing = await this.findById(id);
		if (!existing) {
			return null;
		}

		await this.db.updateTable("media").set({ status: "failed" }).where("id", "=", id).execute();

		return this.findById(id);
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

		if (options.mimeType) {
			const pattern = `${escapeLike(options.mimeType)}%`;
			query = query.where(sql<SqlBool>`mime_type LIKE ${pattern} ESCAPE '\\'`);
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
	async delete(id: string): Promise<boolean> {
		const result = await this.db.deleteFrom("media").where("id", "=", id).executeTakeFirst();

		return (result.numDeletedRows ?? 0) > 0;
	}

	/**
	 * Count media items
	 */
	async count(mimeType?: string): Promise<number> {
		let query = this.db.selectFrom("media").select((eb) => eb.fn.count("id").as("count"));

		if (mimeType) {
			const pattern = `${escapeLike(mimeType)}%`;
			query = query.where(sql<SqlBool>`mime_type LIKE ${pattern} ESCAPE '\\'`);
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

		// Select the storage keys first -- SQLite doesn't support RETURNING
		// on DELETE in all drivers, and Kysely's RETURNING isn't universal.
		const rows = await this.db
			.selectFrom("media")
			.select("storage_key")
			.where("status", "=", "pending")
			.where("created_at", "<", cutoff)
			.execute();

		if (rows.length === 0) return [];

		await this.db
			.deleteFrom("media")
			.where("status", "=", "pending")
			.where("created_at", "<", cutoff)
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
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- DB stores string; validated at insert but linter can't follow
			status: row.status as MediaStatus,
			createdAt: row.created_at,
			authorId: row.author_id,
		};
	}
}
