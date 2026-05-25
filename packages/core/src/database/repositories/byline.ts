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
	/**
	 * Locale this byline row belongs to. When omitted, the DB DEFAULT (the
	 * configured `defaultLocale` after migration 040) is used. Keeps behaviour
	 * consistent with `TaxonomyRepository.create`.
	 */
	locale?: string;
	/**
	 * When set, the new row joins the source byline's translation_group rather
	 * than minting a fresh one. The source must exist; otherwise the create
	 * throws. Mirrors `TaxonomyRepository.create`.
	 */
	translationOf?: string;
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
		locale: row.locale,
		translationGroup: row.translation_group,
	};
}

/**
 * Byline repository for content credits.
 *
 * Bylines are per-locale (migration 040). Translations of the same byline
 * share a `translation_group` ULID. `_emdash_content_bylines.byline_id` and
 * `ec_*.primary_byline_id` store the translation_group (not a row id) so a
 * single credit spans every locale variant of a byline.
 *
 * The repository does not resolve locale fallbacks on its own — callers
 * supply the locale they want. Hydration is strict per locale: a credit at
 * locale X renders iff a byline row exists at locale X within the credited
 * translation group. This mirrors `TaxonomyRepository.getTermsForEntry` and
 * the convention established by PR #916.
 *
 * Runtime helpers in `packages/core/src/bylines/index.ts` may layer fallback
 * resolution on top for the "look up one byline by slug" path, but the
 * relation-hydration methods on this class are always strict.
 */
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

	/**
	 * Find a byline by slug. When `locale` is provided, filter by it strictly.
	 * When omitted, returns the lowest-locale-code match (deterministic across
	 * calls). Mirrors `TaxonomyRepository.findBySlug`.
	 */
	async findBySlug(slug: string, options?: { locale?: string }): Promise<BylineSummary | null> {
		let query = this.db.selectFrom("_emdash_bylines").selectAll().where("slug", "=", slug);
		if (options?.locale !== undefined) query = query.where("locale", "=", options.locale);
		const row = await query.orderBy("locale", "asc").executeTakeFirst();
		return row ? rowToByline(row) : null;
	}

	/**
	 * Find the byline linked to a CMS user. Post-migration 040 the partial
	 * unique on user_id is `(user_id, locale)`, so `locale` is required to
	 * disambiguate when multiple locale variants exist. When omitted, returns
	 * the lowest-locale-code match.
	 */
	async findByUserId(userId: string, options?: { locale?: string }): Promise<BylineSummary | null> {
		let query = this.db.selectFrom("_emdash_bylines").selectAll().where("user_id", "=", userId);
		if (options?.locale !== undefined) query = query.where("locale", "=", options.locale);
		const row = await query.orderBy("locale", "asc").executeTakeFirst();
		return row ? rowToByline(row) : null;
	}

	async findMany(options?: {
		search?: string;
		isGuest?: boolean;
		userId?: string;
		locale?: string;
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

		if (options?.locale !== undefined) {
			query = query.where("locale", "=", options.locale);
		}

		if (options?.cursor) {
			const decoded = decodeCursor(options.cursor);
			query = query.where((eb) =>
				eb.or([
					eb("created_at", "<", decoded.orderValue),
					eb.and([eb("created_at", "=", decoded.orderValue), eb("id", "<", decoded.id)]),
				]),
			);
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

	/**
	 * List every sibling row in `translation_group`. Used by the admin
	 * `TranslationsPanel` to render one entry per configured locale.
	 */
	async listTranslations(id: string): Promise<BylineSummary[]> {
		const anchor = await this.findById(id);
		if (!anchor) return [];
		const group = anchor.translationGroup ?? anchor.id;
		return this.findByTranslationGroup(group);
	}

	/**
	 * Direct lookup by `translation_group`. Returns every locale variant of a
	 * byline, ordered by locale code (deterministic).
	 */
	async findByTranslationGroup(translationGroup: string): Promise<BylineSummary[]> {
		const rows = await this.db
			.selectFrom("_emdash_bylines")
			.selectAll()
			.where("translation_group", "=", translationGroup)
			.orderBy("locale", "asc")
			.execute();
		return rows.map(rowToByline);
	}

	async create(input: CreateBylineInput): Promise<BylineSummary> {
		const id = ulid();
		const now = new Date().toISOString();

		// translationOf joins the source byline's group; otherwise we mint a
		// fresh group equal to id (matching migration 040's backfill pattern).
		let translationGroup: string = id;
		if (input.translationOf) {
			const source = await this.findById(input.translationOf);
			if (!source) throw new Error("Source byline for translation not found");
			translationGroup = source.translationGroup ?? source.id;
		}

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
				// When omitted the DB DEFAULT (configured defaultLocale) is used —
				// keeps behaviour consistent with TaxonomyRepository.create.
				...(input.locale !== undefined ? { locale: input.locale } : {}),
				translation_group: translationGroup,
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

	/**
	 * Delete a byline row. When this row is the last sibling in its
	 * translation group, also drops every junction row pointing at the group
	 * and clears `primary_byline_id` references. When other siblings remain
	 * in the group, junctions and `primary_byline_id` pointers stay intact —
	 * the credit lives on at other locales.
	 *
	 * Migration 040 dropped the FK on `_emdash_content_bylines.byline_id`, so
	 * this cascade is implemented here in application code.
	 */
	async delete(id: string): Promise<boolean> {
		const existing = await this.findById(id);
		if (!existing) return false;

		const group = existing.translationGroup ?? existing.id;

		await withTransaction(this.db, async (trx) => {
			await trx.deleteFrom("_emdash_bylines").where("id", "=", id).execute();

			// Count remaining siblings in the translation group. If none
			// remain, purge dependent rows; otherwise leave them intact so
			// the credit still resolves at other locales.
			const remaining = await trx
				.selectFrom("_emdash_bylines")
				.select(({ fn }) => [fn.count<number>("id").as("count")])
				.where("translation_group", "=", group)
				.executeTakeFirst();
			const remainingCount = Number(remaining?.count ?? 0);
			if (remainingCount > 0) return;

			// Last sibling gone: cascade in application code.
			await trx.deleteFrom("_emdash_content_bylines").where("byline_id", "=", group).execute();

			const tableNames = await listTablesLike(trx, "ec_%");
			for (const tableName of tableNames) {
				validateIdentifier(tableName, "content table");
				await sql`
					UPDATE ${sql.ref(tableName)}
					SET primary_byline_id = NULL
					WHERE primary_byline_id = ${group}
				`.execute(trx);
			}
		});

		return true;
	}

	/**
	 * Strict per-locale credit hydration. Joins `_emdash_content_bylines` to
	 * `_emdash_bylines` on `translation_group = byline_id`, then filters to
	 * the requested locale. Credits whose translation group lacks a row at
	 * the requested locale are omitted — callers wanting fallback behaviour
	 * apply it themselves. Mirrors `TaxonomyRepository.getTermsForEntry`.
	 */
	async getContentBylines(
		collectionSlug: string,
		contentId: string,
		options?: { locale?: string },
	): Promise<ContentBylineCredit[]> {
		let query = this.db
			.selectFrom("_emdash_content_bylines as cb")
			.innerJoin("_emdash_bylines as b", "b.translation_group", "cb.byline_id")
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
				"b.locale as locale",
				"b.translation_group as translation_group",
			])
			.where("cb.collection_slug", "=", collectionSlug)
			.where("cb.content_id", "=", contentId)
			.orderBy("cb.sort_order", "asc");
		if (options?.locale !== undefined) query = query.where("b.locale", "=", options.locale);

		const rows = await query.execute();
		return rows.map((row) => ({
			byline: rowToByline(row),
			sortOrder: row.sort_order,
			roleLabel: row.role_label,
		}));
	}

	/**
	 * Does this entry have any explicit byline credits — at any locale?
	 *
	 * Used to disambiguate "no credits exist" (fall back to author-linked
	 * byline) from "credits exist but don't resolve at the requested locale"
	 * (strict per-locale model: render no byline). Without this check the
	 * locale-strict hydration would silently turn a missing translation into
	 * an author-inferred byline, contradicting editorial intent.
	 */
	async hasContentBylines(collectionSlug: string, contentId: string): Promise<boolean> {
		const row = await this.db
			.selectFrom("_emdash_content_bylines")
			.select("id")
			.where("collection_slug", "=", collectionSlug)
			.where("content_id", "=", contentId)
			.limit(1)
			.executeTakeFirst();
		return row !== undefined;
	}

	/**
	 * Batch variant of `hasContentBylines`. Returns the set of content IDs
	 * that have at least one junction row (locale-agnostic).
	 */
	async hasContentBylinesMany(collectionSlug: string, contentIds: string[]): Promise<Set<string>> {
		const result = new Set<string>();
		if (contentIds.length === 0) return result;

		const uniqueContentIds = [...new Set(contentIds)];
		for (const chunk of chunks(uniqueContentIds, SQL_BATCH_SIZE)) {
			const rows = await this.db
				.selectFrom("_emdash_content_bylines")
				.select("content_id")
				.distinct()
				.where("collection_slug", "=", collectionSlug)
				.where("content_id", "in", chunk)
				.execute();
			for (const row of rows) result.add(row.content_id);
		}
		return result;
	}

	/**
	 * Batch variant of `getContentBylines`. Same strict-per-locale semantics
	 * applied to the requested locale (single value, not per-entry).
	 *
	 * When callers need per-entry-locale filtering (e.g. a list endpoint
	 * returning entries at mixed locales), they should group the input ids by
	 * the entry's locale and call this method once per group.
	 */
	async getContentBylinesMany(
		collectionSlug: string,
		contentIds: string[],
		options?: { locale?: string },
	): Promise<Map<string, ContentBylineCredit[]>> {
		const result = new Map<string, ContentBylineCredit[]>();
		if (contentIds.length === 0) return result;

		const uniqueContentIds = [...new Set(contentIds)];
		for (const chunk of chunks(uniqueContentIds, SQL_BATCH_SIZE)) {
			let query = this.db
				.selectFrom("_emdash_content_bylines as cb")
				.innerJoin("_emdash_bylines as b", "b.translation_group", "cb.byline_id")
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
					"b.locale as locale",
					"b.translation_group as translation_group",
				])
				.where("cb.collection_slug", "=", collectionSlug)
				.where("cb.content_id", "in", chunk)
				.orderBy("cb.sort_order", "asc");
			if (options?.locale !== undefined) query = query.where("b.locale", "=", options.locale);

			const rows = await query.execute();

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
	 * Strict-locale variant of `findByUserId`.
	 */
	async findByUserIds(
		userIds: string[],
		options?: { locale?: string },
	): Promise<Map<string, BylineSummary>> {
		const result = new Map<string, BylineSummary>();
		if (userIds.length === 0) return result;

		for (const chunk of chunks(userIds, SQL_BATCH_SIZE)) {
			let query = this.db.selectFrom("_emdash_bylines").selectAll().where("user_id", "in", chunk);
			if (options?.locale !== undefined) query = query.where("locale", "=", options.locale);

			const rows = await query.execute();

			for (const row of rows) {
				if (row.user_id) {
					result.set(row.user_id, rowToByline(row));
				}
			}
		}
		return result;
	}

	/**
	 * Clone every junction row from `sourceContentId` to `targetContentId`,
	 * preserving `sort_order` and `role_label`. Used by the content
	 * translation flow: a newly created translation inherits the source's
	 * byline credits at the storage level. Because the junction stores
	 * `translation_group` (not a row id), the copy is locale-agnostic — the
	 * credits resolve to whichever locale variants of each byline exist when
	 * the translated entry is hydrated.
	 *
	 * No-op when the source has no credits. Skips when the target already
	 * has credits (idempotent for re-runs).
	 */
	async copyContentBylines(
		collection: string,
		sourceContentId: string,
		targetContentId: string,
	): Promise<void> {
		validateIdentifier(collection, "collection slug");
		const tableName = `ec_${collection}`;
		validateIdentifier(tableName, "content table");

		// Like `setContentBylines`, this method is expected to be called
		// within a transaction context (content handlers wrap in
		// withTransaction). All operations use `this.db` directly so an
		// outer transaction can serialise the copy alongside the create.
		const existing = await this.db
			.selectFrom("_emdash_content_bylines")
			.select("id")
			.where("collection_slug", "=", collection)
			.where("content_id", "=", targetContentId)
			.executeTakeFirst();
		if (existing) return;

		const sourceRows = await this.db
			.selectFrom("_emdash_content_bylines")
			.select(["byline_id", "sort_order", "role_label"])
			.where("collection_slug", "=", collection)
			.where("content_id", "=", sourceContentId)
			.orderBy("sort_order", "asc")
			.execute();
		if (sourceRows.length === 0) return;

		const now = new Date().toISOString();
		await this.db
			.insertInto("_emdash_content_bylines")
			.values(
				sourceRows.map((row) => ({
					id: ulid(),
					collection_slug: collection,
					content_id: targetContentId,
					byline_id: row.byline_id,
					sort_order: row.sort_order,
					role_label: row.role_label,
					created_at: now,
				})),
			)
			.execute();

		// Mirror primary_byline_id from source so the cached pointer on the
		// target row matches the junction state we just wrote.
		const firstByline = sourceRows[0]?.byline_id ?? null;
		await sql`
			UPDATE ${sql.ref(tableName)}
			SET primary_byline_id = ${firstByline}
			WHERE id = ${targetContentId}
		`.execute(this.db);
	}

	/**
	 * Replace the set of byline credits on a content entry. Accepts row ids
	 * at the wire (consistent with how the admin sends them), translates
	 * each to its `translation_group` on write, and stores the group in
	 * `_emdash_content_bylines.byline_id` and `ec_*.primary_byline_id`.
	 *
	 * The returned credits are hydrated with strict-locale matching at the
	 * locale of the rows the caller supplied (i.e. the locale of the byline
	 * each `bylineId` resolves to) — adequate for the autosave round-trip,
	 * which then re-hydrates the entry against its own locale separately.
	 */
	async setContentBylines(
		collectionSlug: string,
		contentId: string,
		inputBylines: ContentBylineInput[],
	): Promise<ContentBylineCredit[]> {
		validateIdentifier(collectionSlug, "collection slug");
		const tableName = `ec_${collectionSlug}`;
		validateIdentifier(tableName, "content table");

		// Resolve each wire row id to its translation_group up front so we
		// can (a) validate the rows exist and (b) dedupe by the value that
		// actually lands in the junction. Deduping by wire row id BEFORE
		// resolving would let two locale siblings of the same byline slip
		// through and trigger a UNIQUE(collection, content, byline_id)
		// failure at insert time. A single SELECT keeps this O(1) DB
		// calls regardless of how many credits are being set.
		const idToGroup = new Map<string, string>();
		if (inputBylines.length > 0) {
			const wireIds = [...new Set(inputBylines.map((item) => item.bylineId))];
			const rows = await this.db
				.selectFrom("_emdash_bylines")
				.select(["id", "translation_group"])
				.where("id", "in", wireIds)
				.execute();
			if (rows.length !== wireIds.length) {
				throw new Error("One or more byline IDs do not exist");
			}
			for (const row of rows) {
				idToGroup.set(row.id, row.translation_group ?? row.id);
			}
		}

		// Dedupe by translation_group. Preserves the order of first
		// occurrence so the editor's intent (which sibling appears first)
		// is honored. `roleLabel` follows the first occurrence too.
		const seenGroups = new Set<string>();
		const bylines: Array<ContentBylineInput & { group: string }> = [];
		for (const item of inputBylines) {
			const group = idToGroup.get(item.bylineId);
			if (!group) {
				throw new Error(`Missing translation_group for byline ${item.bylineId}`);
			}
			if (seenGroups.has(group)) continue;
			seenGroups.add(group);
			bylines.push({ ...item, group });
		}

		// This method is expected to be called within a transaction context
		// (content handlers wrap in withTransaction, seed applies sequentially).
		// All operations use this.db directly -- callers are responsible for
		// wrapping in a transaction when atomicity is required.
		await this.db
			.deleteFrom("_emdash_content_bylines")
			.where("collection_slug", "=", collectionSlug)
			.where("content_id", "=", contentId)
			.execute();

		for (let i = 0; i < bylines.length; i++) {
			const item = bylines[i];
			if (!item) continue;
			await this.db
				.insertInto("_emdash_content_bylines")
				.values({
					id: ulid(),
					collection_slug: collectionSlug,
					content_id: contentId,
					byline_id: item.group,
					sort_order: i,
					role_label: item.roleLabel ?? null,
					created_at: new Date().toISOString(),
				})
				.execute();
		}

		const primaryGroup = bylines[0]?.group ?? null;
		await sql`
			UPDATE ${sql.ref(tableName)}
			SET primary_byline_id = ${primaryGroup}
			WHERE id = ${contentId}
		`.execute(this.db);

		return await this.getContentBylines(collectionSlug, contentId);
	}
}
