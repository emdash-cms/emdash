import { sql, type Kysely, type Selectable } from "kysely";
import { ulid } from "ulidx";

import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { listTablesLike } from "../dialect-helpers.js";
import { withTransaction } from "../transaction.js";
import type { BylineTable, Database } from "../types.js";
import { validateIdentifier } from "../validate.js";
import {
	decodeCursor,
	encodeCursor,
	type BylineSummary,
	type ContentBylineCredit,
	type FindManyResult,
} from "./types.js";

type BylineRow = Selectable<BylineTable>;

export interface CreateBylineInput {
	slug: string;
	displayName: string;
	bio?: string | null;
	avatarMediaId?: string | null;
	websiteUrl?: string | null;
	userId?: string | null;
	isGuest?: boolean;
}

export interface UpdateBylineInput {
	slug?: string;
	displayName?: string;
	bio?: string | null;
	avatarMediaId?: string | null;
	websiteUrl?: string | null;
	userId?: string | null;
	isGuest?: boolean;
}

export interface ContentBylineInput {
	bylineId: string;
	roleLabel?: string | null;
}

function rowToByline(row: BylineRow): BylineSummary {
	return {
		id: row.id,
		slug: row.slug,
		displayName: row.display_name,
		bio: row.bio,
		avatarMediaId: row.avatar_media_id,
		websiteUrl: row.website_url,
		userId: row.user_id,
		isGuest: row.is_guest === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class BylineRepository {
	constructor(private db: Kysely<Database>) {}

	async findById(id: string): Promise<BylineSummary | null> {
		const row = await this.db
			.selectFrom("_emdash_bylines")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		return row ? rowToByline(row) : null;
	}

	async findBySlug(slug: string): Promise<BylineSummary | null> {
		const row = await this.db
			.selectFrom("_emdash_bylines")
			.selectAll()
			.where("slug", "=", slug)
			.executeTakeFirst();
		return row ? rowToByline(row) : null;
	}

	async findByUserId(userId: string): Promise<BylineSummary | null> {
		const row = await this.db
			.selectFrom("_emdash_bylines")
			.selectAll()
			.where("user_id", "=", userId)
			.executeTakeFirst();
		return row ? rowToByline(row) : null;
	}

	async findMany(options?: {
		search?: string;
		isGuest?: boolean;
		userId?: string;
		cursor?: string;
		limit?: number;
	}): Promise<FindManyResult<BylineSummary>> {
		const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);

		let query = this.db
			.selectFrom("_emdash_bylines")
			.selectAll()
			.orderBy("created_at", "desc")
			.orderBy("id", "desc")
			.limit(limit + 1);

		if (options?.search) {
			const escaped = options.search
				.replaceAll("\\", "\\\\")
				.replaceAll("%", "\\%")
				.replaceAll("_", "\\_");
			const term = `%${escaped}%`;
			query = query.where((eb) =>
				eb.or([eb("display_name", "like", term), eb("slug", "like", term)]),
			);
		}

		if (options?.isGuest !== undefined) {
			query = query.where("is_guest", "=", options.isGuest ? 1 : 0);
		}

		if (options?.userId !== undefined) {
			query = query.where("user_id", "=", options.userId);
		}

		if (options?.cursor) {
			const decoded = decodeCursor(options.cursor);
			if (decoded) {
				query = query.where((eb) =>
					eb.or([
						eb("created_at", "<", decoded.orderValue),
						eb.and([eb("created_at", "=", decoded.orderValue), eb("id", "<", decoded.id)]),
					]),
				);
			}
		}

		const rows = await query.execute();
		const items = rows.slice(0, limit).map(rowToByline);
		const result: FindManyResult<BylineSummary> = { items };

		if (rows.length > limit) {
			const last = items.at(-1);
			if (last) {
				result.nextCursor = encodeCursor(last.createdAt, last.id);
			}
		}

		return result;
	}

	async create(input: CreateBylineInput): Promise<BylineSummary> {
		const id = ulid();
		const now = new Date().toISOString();

		await this.db
			.insertInto("_emdash_bylines")
			.values({
				id,
				slug: input.slug,
				display_name: input.displayName,
				bio: input.bio ?? null,
				avatar_media_id: input.avatarMediaId ?? null,
				website_url: input.websiteUrl ?? null,
				user_id: input.userId ?? null,
				is_guest: input.isGuest ? 1 : 0,
				created_at: now,
				updated_at: now,
			})
			.execute();

		const byline = await this.findById(id);
		if (!byline) {
			throw new Error("Failed to create byline");
		}
		return byline;
	}

	async update(id: string, input: UpdateBylineInput): Promise<BylineSummary | null> {
		const existing = await this.findById(id);
		if (!existing) return null;

		const updates: Record<string, unknown> = {
			updated_at: new Date().toISOString(),
		};

		if (input.slug !== undefined) updates.slug = input.slug;
		if (input.displayName !== undefined) updates.display_name = input.displayName;
		if (input.bio !== undefined) updates.bio = input.bio;
		if (input.avatarMediaId !== undefined) updates.avatar_media_id = input.avatarMediaId;
		if (input.websiteUrl !== undefined) updates.website_url = input.websiteUrl;
		if (input.userId !== undefined) updates.user_id = input.userId;
		if (input.isGuest !== undefined) updates.is_guest = input.isGuest ? 1 : 0;

		await this.db.updateTable("_emdash_bylines").set(updates).where("id", "=", id).execute();
		return await this.findById(id);
	}

	async delete(id: string): Promise<boolean> {
		const existing = await this.findById(id);
		if (!existing) return false;

		await withTransaction(this.db, async (trx) => {
			await trx.deleteFrom("_emdash_content_bylines").where("byline_id", "=", id).execute();

			await trx.deleteFrom("_emdash_bylines").where("id", "=", id).execute();

			const tableNames = await listTablesLike(trx, "ec_%");
			for (const tableName of tableNames) {
				validateIdentifier(tableName, "content table");
				await sql`
					UPDATE ${sql.ref(tableName)}
					SET primary_byline_id = NULL
					WHERE primary_byline_id = ${id}
				`.execute(trx);
			}
		});

		return true;
	}

	async getContentBylines(
		collectionSlug: string,
		contentId: string,
	): Promise<ContentBylineCredit[]> {
		const rows = await this.db
			.selectFrom("_emdash_content_bylines as cb")
			.innerJoin("_emdash_bylines as b", "b.id", "cb.byline_id")
			.select([
				"cb.sort_order as sort_order",
				"cb.role_label as role_label",
				"b.id as id",
				"b.slug as slug",
				"b.display_name as display_name",
				"b.bio as bio",
				"b.avatar_media_id as avatar_media_id",
				"b.website_url as website_url",
				"b.user_id as user_id",
				"b.is_guest as is_guest",
				"b.created_at as created_at",
				"b.updated_at as updated_at",
			])
			.where("cb.collection_slug", "=", collectionSlug)
			.where("cb.content_id", "=", contentId)
			.orderBy("cb.sort_order", "asc")
			.execute();

		return rows.map((row) => ({
			byline: rowToByline(row),
			sortOrder: row.sort_order,
			roleLabel: row.role_label,
		}));
	}

	/**
	 * Batch-fetch byline credits for multiple content items in a single query.
	 * Returns a Map keyed by contentId.
	 */
	async getContentBylinesMany(
		collectionSlug: string,
		contentIds: string[],
	): Promise<Map<string, ContentBylineCredit[]>> {
		const result = new Map<string, ContentBylineCredit[]>();
		if (contentIds.length === 0) return result;

		const uniqueContentIds = [...new Set(contentIds)];
		for (const chunk of chunks(uniqueContentIds, SQL_BATCH_SIZE)) {
			const rows = await this.db
				.selectFrom("_emdash_content_bylines as cb")
				.innerJoin("_emdash_bylines as b", "b.id", "cb.byline_id")
				.select([
					"cb.content_id as content_id",
					"cb.sort_order as sort_order",
					"cb.role_label as role_label",
					"b.id as id",
					"b.slug as slug",
					"b.display_name as display_name",
					"b.bio as bio",
					"b.avatar_media_id as avatar_media_id",
					"b.website_url as website_url",
					"b.user_id as user_id",
					"b.is_guest as is_guest",
					"b.created_at as created_at",
					"b.updated_at as updated_at",
				])
				.where("cb.collection_slug", "=", collectionSlug)
				.where("cb.content_id", "in", chunk)
				.orderBy("cb.sort_order", "asc")
				.execute();

			for (const row of rows) {
				const contentId = row.content_id;
				const credit: ContentBylineCredit = {
					byline: rowToByline(row),
					sortOrder: row.sort_order,
					roleLabel: row.role_label,
				};
				const existing = result.get(contentId);
				if (existing) {
					existing.push(credit);
				} else {
					result.set(contentId, [credit]);
				}
			}
		}

		return result;
	}

	/**
	 * Batch-fetch byline profiles linked to user IDs in a single query.
	 * Returns a Map keyed by userId.
	 */
	async findByUserIds(userIds: string[]): Promise<Map<string, BylineSummary>> {
		const result = new Map<string, BylineSummary>();
		if (userIds.length === 0) return result;

		for (const chunk of chunks(userIds, SQL_BATCH_SIZE)) {
			const rows = await this.db
				.selectFrom("_emdash_bylines")
				.selectAll()
				.where("user_id", "in", chunk)
				.execute();

			for (const row of rows) {
				if (row.user_id) {
					result.set(row.user_id, rowToByline(row));
				}
			}
		}
		return result;
	}

	async setContentBylines(
		collectionSlug: string,
		contentId: string,
		inputBylines: ContentBylineInput[],
	): Promise<ContentBylineCredit[]> {
		validateIdentifier(collectionSlug, "collection slug");
		const tableName = `ec_${collectionSlug}`;
		validateIdentifier(tableName, "content table");

		const seen = new Set<string>();
		const bylines = inputBylines.filter((item) => {
			if (seen.has(item.bylineId)) return false;
			seen.add(item.bylineId);
			return true;
		});

		// This method is expected to be called within a transaction context
		// (content handlers wrap in withTransaction, seed applies sequentially).
		// All operations use this.db directly -- callers are responsible for
		// wrapping in a transaction when atomicity is required.
		if (bylines.length > 0) {
			const ids = bylines.map((item) => item.bylineId);
			const rows = await this.db
				.selectFrom("_emdash_bylines")
				.select("id")
				.where("id", "in", ids)
				.execute();
			if (rows.length !== ids.length) {
				throw new Error("One or more byline IDs do not exist");
			}
		}

		await this.db
			.deleteFrom("_emdash_content_bylines")
			.where("collection_slug", "=", collectionSlug)
			.where("content_id", "=", contentId)
			.execute();

		for (let i = 0; i < bylines.length; i++) {
			const item = bylines[i];
			await this.db
				.insertInto("_emdash_content_bylines")
				.values({
					id: ulid(),
					collection_slug: collectionSlug,
					content_id: contentId,
					byline_id: item.bylineId,
					sort_order: i,
					role_label: item.roleLabel ?? null,
					created_at: new Date().toISOString(),
				})
				.execute();
		}

		await sql`
			UPDATE ${sql.ref(tableName)}
			SET primary_byline_id = ${bylines[0]?.bylineId ?? null}
			WHERE id = ${contentId}
		`.execute(this.db);

		return await this.getContentBylines(collectionSlug, contentId);
	}
}
