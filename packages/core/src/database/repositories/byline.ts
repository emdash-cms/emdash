import { sql, type Kysely, type Selectable } from "kysely";
import { ulid } from "ulidx";

import { getBylineFieldDefs } from "../../bylines/field-defs-cache.js";
import {
	invalidateBylineObjectCache,
	invalidateCollectionCache,
} from "../../object-cache/index.js";
import {
	clearRequestCacheEntry,
	peekRequestCache,
	setRequestCacheEntry,
} from "../../request-cache.js";
import type { BylineFieldDefinition, CustomFieldValue } from "../../schema/types.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { listTablesLike } from "../dialect-helpers.js";
import { withTransaction } from "../transaction.js";
import type { BylineTable, Database } from "../types.js";
import { validateIdentifier } from "../validate.js";
import {
	decodeCursor,
	EmDashValidationError,
	encodeCursor,
	type BylineSummary,
	type ContentBylineCredit,
	type FindManyResult,
} from "./types.js";

type BylineRow = Selectable<BylineTable>;

/**
 * A byline row optionally augmented with the avatar's media columns, folded in
 * by the `LEFT JOIN media` in the content-credit hydration queries. The plain
 * `selectAll()` finders produce rows without these keys, so they're optional
 * and `rowToByline` defaults them to null.
 */
type BylineRowWithAvatar = BylineRow & {
	avatar_storage_key?: string | null;
	avatar_alt?: string | null;
	avatar_blurhash?: string | null;
	avatar_dominant_color?: string | null;
};

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
	/**
	 * Byline custom-field values to seed on the new row (Phase 6 of
	 * Discussion #1174). Same semantics as `UpdateBylineInput.customFields`:
	 * keys must match registered slugs in `_emdash_byline_fields`, values
	 * are validated against the field's type, and writes route to
	 * `_emdash_byline_field_values` (translatable) or
	 * `_emdash_byline_field_group_values` (group-shared). Validation runs
	 * before the row insert so a bad value can't leave a bare byline behind.
	 */
	customFields?: Record<string, unknown>;
}

export interface UpdateBylineInput {
	slug?: string;
	displayName?: string;
	bio?: string | null;
	avatarMediaId?: string | null;
	websiteUrl?: string | null;
	userId?: string | null;
	isGuest?: boolean;
	/**
	 * Byline custom-field values to write (Phase 3 of Discussion #1174).
	 *
	 * Each key must match a registered slug in `_emdash_byline_fields`;
	 * unknown keys throw `EmDashValidationError`. Per-field writes route
	 * to `_emdash_byline_field_values` (when the field's `translatable`
	 * flag is true) or `_emdash_byline_field_group_values` (when false).
	 * A value of `null` clears the row.
	 *
	 * Values are validated against the field's type:
	 * - `string` / `text` / `url` accept a `string`
	 * - `boolean` accepts a `boolean`
	 * - `select` accepts a `string` that appears in `validation.options`
	 *
	 * Writes are idempotent (`INSERT … ON CONFLICT DO UPDATE`), so
	 * retrying the same update produces the same DB state.
	 */
	customFields?: Record<string, unknown>;
}

export interface ContentBylineInput {
	bylineId: string;
	roleLabel?: string | null;
}

function rowToByline(row: BylineRowWithAvatar): BylineSummary {
	return {
		id: row.id,
		slug: row.slug,
		displayName: row.display_name,
		bio: row.bio,
		avatarMediaId: row.avatar_media_id,
		avatarStorageKey: row.avatar_storage_key ?? null,
		avatarAlt: row.avatar_alt ?? null,
		avatarBlurhash: row.avatar_blurhash ?? null,
		avatarDominantColor: row.avatar_dominant_color ?? null,
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
 * Merge a single decoded value into a `BylineSummary.customFields` map.
 * Centralised so the merge semantics (null storage, JSON.parse failure
 * handling) live in one place across both translatable and group-shared
 * paths.
 *
 * A stored row with `value = NULL` (representing an explicit null) is
 * surfaced as `null` in `customFields`. A row with a malformed JSON
 * payload is dropped silently with a `console.warn` — a corrupted
 * payload shouldn't break the entire byline hydration; the field-defs
 * cache will let admins replace the value, and the warning makes the
 * issue debuggable. (Storage path uses `JSON.stringify`, so the only
 * way to get malformed JSON is direct DB tampering or a future
 * migration bug.)
 */
function assignCustomFieldValue(
	summary: BylineSummary,
	field: BylineFieldDefinition,
	stored: string | null,
): void {
	const target = summary.customFields ?? {};
	if (stored === null) {
		target[field.slug] = null;
	} else {
		try {
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- coerceFieldValue ran at write time, see field-defs-cache.ts
			target[field.slug] = JSON.parse(stored) as CustomFieldValue;
		} catch {
			console.warn(
				`[BylineRepository] dropping malformed JSON for byline=${summary.id} ` +
					`field=${field.slug}: ${stored.slice(0, 60)}`,
			);
			return;
		}
	}
	summary.customFields = target;
}

/**
 * Coerce a raw write-path value to `CustomFieldValue`, throwing
 * `EmDashValidationError` on type mismatch. `null` clears the field
 * (DELETE in the write path).
 *
 * TODO: `field.required` is not enforced. The admin UI exposes the
 * toggle but the backend accepts missing values; design pass needed
 * on the enforcement model.
 */
function coerceFieldValue(field: BylineFieldDefinition, raw: unknown): CustomFieldValue {
	if (raw === null) return null;

	switch (field.type) {
		case "string":
		case "text": {
			if (typeof raw !== "string") {
				throw new EmDashValidationError(
					`Byline field "${field.slug}" expects a string value (received ${typeof raw})`,
					{ slug: field.slug, type: field.type, received: typeof raw },
				);
			}
			return raw;
		}
		case "url": {
			if (typeof raw !== "string") {
				throw new EmDashValidationError(
					`Byline field "${field.slug}" expects a string value (received ${typeof raw})`,
					{ slug: field.slug, type: field.type, received: typeof raw },
				);
			}
			// Empty string round-trips as a clear from the admin UI; any
			// non-empty value must be a valid http(s) URL. The scheme
			// allowlist mirrors `httpUrl` in `api/schemas/common.ts` —
			// `new URL` alone would accept `javascript:`/`data:` etc.
			if (raw === "") return raw;
			let parsed: URL;
			try {
				parsed = new URL(raw);
			} catch {
				throw new EmDashValidationError(
					`Byline field "${field.slug}" expects a valid URL (received "${raw}")`,
					{ slug: field.slug, type: field.type, received: raw },
				);
			}
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				throw new EmDashValidationError(
					`Byline field "${field.slug}" must use http or https scheme (received "${parsed.protocol}")`,
					{ slug: field.slug, type: field.type, received: raw, protocol: parsed.protocol },
				);
			}
			return raw;
		}
		case "boolean": {
			if (typeof raw !== "boolean") {
				throw new EmDashValidationError(
					`Byline field "${field.slug}" expects a boolean value (received ${typeof raw})`,
					{ slug: field.slug, type: field.type, received: typeof raw },
				);
			}
			return raw;
		}
		case "select": {
			if (typeof raw !== "string") {
				throw new EmDashValidationError(
					`Byline field "${field.slug}" expects a string value (received ${typeof raw})`,
					{ slug: field.slug, type: field.type, received: typeof raw },
				);
			}
			const options = field.validation?.options ?? [];
			if (!options.includes(raw)) {
				throw new EmDashValidationError(
					`Byline field "${field.slug}" value "${raw}" is not one of the registered choices`,
					{ slug: field.slug, value: raw, options },
				);
			}
			return raw;
		}
	}
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

	// ============================================
	// Custom-field hydration (Phase 3 of #1174)
	// ============================================

	/**
	 * Merge `customFields` onto each `BylineSummary` produced from the
	 * given rows. Two batched queries total — one against
	 * `_emdash_byline_field_values` (keyed by `byline_id`), one against
	 * `_emdash_byline_field_group_values` (keyed by `translation_group`)
	 * — both chunked at `SQL_BATCH_SIZE` for D1's bound-parameter cap.
	 *
	 * When zero fields are registered, every row gets `customFields = {}`
	 * with no value-table reads (the field-defs cache returns `[]`).
	 * Group-shared values are looked up via the row's `translation_group`,
	 * so every locale sibling of the same byline identity sees the same
	 * non-translatable value without re-reading per row.
	 *
	 * **Duplicate-row handling.** Callers (notably `getContentBylinesMany`
	 * for list views with repeated authors) can pass the same byline row
	 * multiple times. We assign values by *iterating both `rows` and
	 * `summaries` in lockstep by index*, not by deduping into a Map keyed
	 * on byline id. A Map approach silently drops earlier duplicates' merge
	 * step (last writer wins, earlier instances keep their initial `{}`).
	 * Iterating by index gives every duplicate its own merged copy.
	 *
	 * Hydration is *strict per row* — values are merged onto whichever
	 * `BylineRow` produced them. Fallback semantics (e.g. "if no value
	 * for this locale, show the default-locale value") are not the
	 * repository's concern; consumers layer them on top if wanted, the
	 * same way `BylineRepository` doesn't resolve locale fallback for
	 * the base byline lookup.
	 */
	private async withCustomFields(rows: BylineRow[]): Promise<BylineSummary[]> {
		const summaries = rows.map(rowToByline);
		// Always populate `customFields = {}` (PR plan AC #6) — even when
		// no fields are registered, every BylineSummary carries the empty
		// object. A fresh object per summary so duplicate rows don't share
		// state.
		for (const summary of summaries) {
			summary.customFields = {};
		}
		await this.applyCustomFieldsTo(summaries);
		return summaries;
	}

	private async withCustomFieldsOne(row: BylineRow | undefined): Promise<BylineSummary | null> {
		if (!row) return null;
		const [result] = await this.withCustomFields([row]);
		return result ?? null;
	}

	/**
	 * Hydrate `customFields` on each `BylineSummary`, mutating in place.
	 *
	 * The public entry point for callers that fetch byline rows in
	 * multiple passes (e.g. `getBylinesForEntries`, which buckets by
	 * locale and calls `getContentBylinesMany` per bucket) and want a
	 * single batched hydration over the union of bylines, not one per
	 * pass. Use with the `skipHydration` option on the read methods to
	 * defer customFields work to a single call here.
	 *
	 * Two batched queries total (translatable + group-shared) regardless
	 * of how many bylines, locales, or translation_groups are in the
	 * input — meets the Phase 3 query-count envelope for mixed-locale
	 * list views even when sibling locales reference disjoint
	 * translation_groups.
	 *
	 * Replaces any existing `customFields` on each summary with a freshly
	 * fetched map. Callers that want to merge rather than replace should
	 * not use this entry point.
	 */
	async hydrateBylineCustomFields(summaries: BylineSummary[]): Promise<void> {
		for (const summary of summaries) {
			summary.customFields = {};
		}
		await this.applyCustomFieldsTo(summaries);
	}

	/**
	 * Shared merge engine for `withCustomFields` and
	 * `hydrateBylineCustomFields`. Reads field defs (cached), batches the
	 * translatable + group-shared fetches, and walks `summaries` directly
	 * to apply values.
	 *
	 * Iterates `summaries` (not a `summaryById` map) so duplicate
	 * `BylineSummary` objects sharing the same `id` — e.g. the same
	 * author credited to multiple entries — each get their own merged
	 * values. The previous Map-based dedup silently dropped earlier
	 * duplicates' merge step.
	 */
	private async applyCustomFieldsTo(summaries: BylineSummary[]): Promise<void> {
		if (summaries.length === 0) return;

		const defs = await getBylineFieldDefs(this.db);
		if (defs.length === 0) return;

		const fieldById = new Map(defs.map((d) => [d.id, d]));

		// Translatable values, batched by byline_id (unique per locale, so
		// IDs across different locale buckets don't collide — one batched
		// query covers everything).
		const translatableByByline = new Map<string, Map<string, string | null>>();
		const bylineIds = [...new Set(summaries.map((s) => s.id))];
		for (const chunk of chunks(bylineIds, SQL_BATCH_SIZE)) {
			const trRows = await this.db
				.selectFrom("_emdash_byline_field_values")
				.select(["byline_id", "field_id", "value"])
				.where("byline_id", "in", chunk)
				.execute();
			for (const trRow of trRows) {
				let fieldMap = translatableByByline.get(trRow.byline_id);
				if (!fieldMap) {
					fieldMap = new Map();
					translatableByByline.set(trRow.byline_id, fieldMap);
				}
				fieldMap.set(trRow.field_id, trRow.value);
			}
		}

		// Group-shared values, batched over the union of translation_groups,
		// with per-group request-cache priming so subsequent calls within
		// the same request share the lookup. Together with the
		// `hydrateBylineCustomFields` + `skipHydration` flow in
		// `getBylinesForEntries`, this keeps mixed-locale list views to
		// **one** group-shared query per request, even for disjoint
		// translation_groups across locale buckets.
		const groups = [
			...new Set(
				summaries
					.map((s) => s.translationGroup)
					.filter((g): g is string => typeof g === "string" && g.length > 0),
			),
		];
		const groupByGroup = await this.loadGroupValuesByIds(groups);

		// Each loop gates on `field.translatable` so a row in the wrong
		// owner table (e.g. left over from a translatable flip) can't
		// leak into hydration.
		for (const summary of summaries) {
			const trValues = translatableByByline.get(summary.id);
			if (trValues) {
				for (const [fieldId, value] of trValues) {
					const field = fieldById.get(fieldId);
					if (!field || !field.translatable) continue;
					assignCustomFieldValue(summary, field, value);
				}
			}

			if (summary.translationGroup) {
				const grpValues = groupByGroup.get(summary.translationGroup);
				if (grpValues) {
					for (const [fieldId, value] of grpValues) {
						const field = fieldById.get(fieldId);
						if (!field || field.translatable) continue;
						assignCustomFieldValue(summary, field, value);
					}
				}
			}
		}
	}

	/**
	 * Resolve the group-shared custom-field values for a set of
	 * translation_groups, sharing work across hydration calls within the
	 * same request via per-group `requestCached` entries.
	 *
	 * The non-translatable storage table (`_emdash_byline_field_group_values`)
	 * is keyed by `translation_group`, which is locale-agnostic. Combining
	 * this method with `skipHydration` on `getContentBylinesMany` and a
	 * single `hydrateBylineCustomFields` call (see
	 * `getBylinesForEntries`) keeps mixed-locale list hydration to **one**
	 * batched group-shared SQL per request — even with disjoint
	 * translation_groups across locale buckets. Solo callers (`findById`,
	 * `findMany`, etc.) still get the same per-call batching they had
	 * before; the cache simply means a second call in the same request
	 * for an overlapping group is free.
	 *
	 * Cache key: `byline-field-group-values:${groupId}` — one entry per
	 * group. Writes use `setRequestCacheEntry` (idempotent, doesn't
	 * overwrite); `BylineRepository.update` calls `clearRequestCacheEntry`
	 * after a group-shared write to keep the cache fresh within the same
	 * request.
	 */
	private async loadGroupValuesByIds(
		groups: string[],
	): Promise<Map<string, Map<string, string | null>>> {
		const result = new Map<string, Map<string, string | null>>();
		if (groups.length === 0) return result;

		// First pass: pull any already-cached groups from the request scope.
		const missing: string[] = [];
		for (const g of groups) {
			const cached = peekRequestCache<Map<string, string | null>>(`byline-field-group-values:${g}`);
			if (cached) {
				result.set(g, await cached);
			} else {
				missing.push(g);
			}
		}

		if (missing.length === 0) return result;

		// Second pass: one batched SQL for the union of all missing groups
		// (chunked for D1's bound-parameter cap). Initialise empty maps for
		// missing groups so the primed cache covers "this group has no
		// values" — preventing a re-fetch on subsequent calls.
		const fetched = new Map<string, Map<string, string | null>>();
		for (const g of missing) fetched.set(g, new Map());
		for (const chunk of chunks(missing, SQL_BATCH_SIZE)) {
			const grpRows = await this.db
				.selectFrom("_emdash_byline_field_group_values")
				.select(["translation_group", "field_id", "value"])
				.where("translation_group", "in", chunk)
				.execute();
			for (const grpRow of grpRows) {
				const fieldMap = fetched.get(grpRow.translation_group);
				if (!fieldMap) continue;
				fieldMap.set(grpRow.field_id, grpRow.value);
			}
		}

		for (const g of missing) {
			const m = fetched.get(g);
			if (!m) continue;
			setRequestCacheEntry(`byline-field-group-values:${g}`, m);
			result.set(g, m);
		}

		return result;
	}

	// ============================================
	// Reads
	// ============================================

	async findById(id: string): Promise<BylineSummary | null> {
		const row = await this.db
			.selectFrom("_emdash_bylines")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		return this.withCustomFieldsOne(row);
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
		return this.withCustomFieldsOne(row);
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
		return this.withCustomFieldsOne(row);
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
		const pageRows = rows.slice(0, limit);
		const items = await this.withCustomFields(pageRows);
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
		return this.withCustomFields(rows);
	}

	/**
	 * Validate a `customFields` input map into a write list before any row
	 * write — throws `EmDashValidationError` on unknown slugs, type
	 * mismatches, or select-choice misses.
	 */
	private async resolveCustomFieldWrites(
		customFields: Record<string, unknown> | undefined,
	): Promise<Array<{ field: BylineFieldDefinition; value: CustomFieldValue }>> {
		if (!customFields || Object.keys(customFields).length === 0) return [];
		const defs = await getBylineFieldDefs(this.db);
		const bySlug = new Map(defs.map((d) => [d.slug, d]));
		const writes: Array<{ field: BylineFieldDefinition; value: CustomFieldValue }> = [];
		for (const [slug, raw] of Object.entries(customFields)) {
			const field = bySlug.get(slug);
			if (!field) {
				throw new EmDashValidationError(`Unknown byline custom field "${slug}"`, {
					slug,
					registered: defs.map((d) => d.slug),
				});
			}
			writes.push({ field, value: coerceFieldValue(field, raw) });
		}
		return writes;
	}

	/**
	 * Write a validated custom-field list against a byline row inside the
	 * caller's transaction. Per-field writes route to
	 * `_emdash_byline_field_values` (translatable) or
	 * `_emdash_byline_field_group_values` (group-shared); `null` clears.
	 * Returns `true` when any group-shared row was touched so the caller
	 * can invalidate the per-request cache post-commit.
	 */
	private async applyCustomFieldWritesInTrx(
		trx: Kysely<Database>,
		bylineId: string,
		translationGroup: string,
		writes: Array<{ field: BylineFieldDefinition; value: CustomFieldValue }>,
		now: string,
	): Promise<boolean> {
		if (writes.length === 0) return false;
		let touchedGroupShared = false;
		for (const { field, value } of writes) {
			if (!field.translatable) touchedGroupShared = true;
			if (field.translatable) {
				if (value === null) {
					await trx
						.deleteFrom("_emdash_byline_field_values")
						.where("byline_id", "=", bylineId)
						.where("field_id", "=", field.id)
						.execute();
				} else {
					const encoded = JSON.stringify(value);
					await trx
						.insertInto("_emdash_byline_field_values")
						.values({
							byline_id: bylineId,
							field_id: field.id,
							value: encoded,
							created_at: now,
							updated_at: now,
						})
						.onConflict((oc) =>
							oc.columns(["byline_id", "field_id"]).doUpdateSet({
								value: encoded,
								updated_at: now,
							}),
						)
						.execute();
				}
			} else {
				if (value === null) {
					await trx
						.deleteFrom("_emdash_byline_field_group_values")
						.where("translation_group", "=", translationGroup)
						.where("field_id", "=", field.id)
						.execute();
				} else {
					const encoded = JSON.stringify(value);
					await trx
						.insertInto("_emdash_byline_field_group_values")
						.values({
							translation_group: translationGroup,
							field_id: field.id,
							value: encoded,
							created_at: now,
							updated_at: now,
						})
						.onConflict((oc) =>
							oc.columns(["translation_group", "field_id"]).doUpdateSet({
								value: encoded,
								updated_at: now,
							}),
						)
						.execute();
				}
			}
		}
		return touchedGroupShared;
	}

	async create(input: CreateBylineInput): Promise<BylineSummary> {
		const id = ulid();
		const now = new Date().toISOString();

		// Validate customFields before opening the transaction so a bad
		// value surfaces as VALIDATION_ERROR without aborting an insert.
		const customFieldWrites = await this.resolveCustomFieldWrites(input.customFields);

		// translationOf joins the source's group; otherwise mint a fresh
		// group = id (matches migration 040's backfill pattern).
		let translationGroup: string = id;
		if (input.translationOf) {
			const source = await this.findById(input.translationOf);
			if (!source) throw new Error("Source byline for translation not found");
			translationGroup = source.translationGroup ?? source.id;
		}

		// Wrap insert + custom-field writes in one transaction so a
		// partial failure rolls both back on Node/PG. D1 still has its
		// own no-transactions limitation — recovery for that path lives
		// in `handleBylineCreate`.
		let touchedGroupShared = false;
		await withTransaction(this.db, async (trx) => {
			await trx
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
					// Omit `locale` so the DB DEFAULT (configured defaultLocale)
					// applies — matches TaxonomyRepository.create.
					...(input.locale !== undefined ? { locale: input.locale } : {}),
					translation_group: translationGroup,
				})
				.execute();

			touchedGroupShared = await this.applyCustomFieldWritesInTrx(
				trx,
				id,
				translationGroup,
				customFieldWrites,
				now,
			);
		});

		if (touchedGroupShared) {
			clearRequestCacheEntry(`byline-field-group-values:${translationGroup}`);
		}
		invalidateBylineObjectCache();

		const byline = await this.findById(id);
		if (!byline) {
			throw new Error("Failed to create byline");
		}
		return byline;
	}

	async update(id: string, input: UpdateBylineInput): Promise<BylineSummary | null> {
		const existing = await this.findById(id);
		if (!existing) return null;

		// Validate customFields before opening the transaction so a bad
		// value surfaces as VALIDATION_ERROR without aborting an update.
		const customFieldWrites = await this.resolveCustomFieldWrites(input.customFields);

		const now = new Date().toISOString();
		const updates: Record<string, unknown> = { updated_at: now };

		if (input.slug !== undefined) updates.slug = input.slug;
		if (input.displayName !== undefined) updates.display_name = input.displayName;
		if (input.bio !== undefined) updates.bio = input.bio;
		if (input.avatarMediaId !== undefined) updates.avatar_media_id = input.avatarMediaId;
		if (input.websiteUrl !== undefined) updates.website_url = input.websiteUrl;
		if (input.userId !== undefined) updates.user_id = input.userId;
		if (input.isGuest !== undefined) updates.is_guest = input.isGuest ? 1 : 0;

		const group = existing.translationGroup ?? existing.id;
		// Wrap row update + custom-field writes in one transaction so a
		// partial failure rolls both back on Node/PG. The post-commit
		// invalidation below clears the per-request cache that the
		// top-of-method `findById` populated for this group.
		let touchedGroupShared = false;
		await withTransaction(this.db, async (trx) => {
			await trx.updateTable("_emdash_bylines").set(updates).where("id", "=", id).execute();
			touchedGroupShared = await this.applyCustomFieldWritesInTrx(
				trx,
				id,
				group,
				customFieldWrites,
				now,
			);
		});

		if (touchedGroupShared) {
			clearRequestCacheEntry(`byline-field-group-values:${group}`);
		}
		invalidateBylineObjectCache();

		return await this.findById(id);
	}

	/**
	 * Delete a byline row. When this row is the last sibling in its
	 * translation group, also drops every junction row pointing at the group,
	 * clears `primary_byline_id` references, and removes the byline's
	 * non-translatable custom-field values. When other siblings remain in
	 * the group, junctions, `primary_byline_id` pointers, and group-shared
	 * custom-field values stay intact — the credit (and its shared metadata)
	 * lives on at other locales.
	 *
	 * **Application-level cascade.** The byline domain has standardised on
	 * app-level cascade rather than trusting FK ON DELETE CASCADE, partly
	 * because migration 040 had to strip its own FK to support the
	 * translation_group remap (#1021), and partly so cleanup doesn't
	 * depend on `PRAGMA foreign_keys = ON` (set in production via
	 * `connection.ts:60`, but easy to bypass in tests, scripts, and
	 * one-off tools). Every byline-related deletion table is cleared
	 * explicitly here:
	 *
	 * - `_emdash_byline_field_values` (per-byline translatable values) —
	 *   migration 041 declares FK ON DELETE CASCADE on `byline_id`; the
	 *   explicit DELETE removes the dependency on that pragma.
	 * - `_emdash_content_bylines` — migration 040 dropped its FK.
	 * - `ec_*.primary_byline_id` — never had an FK.
	 * - `_emdash_byline_field_group_values` (translation-group-keyed) —
	 *   keyed by a text column with no FK to bylines, so app-level cleanup
	 *   is the only path.
	 *
	 * The FKs that remain (migration 041) serve as defense-in-depth.
	 */
	async delete(id: string): Promise<boolean> {
		const existing = await this.findById(id);
		if (!existing) return false;

		const group = existing.translationGroup ?? existing.id;

		await withTransaction(this.db, async (trx) => {
			// Per-row translatable custom-field values. Done BEFORE the
			// byline row delete so the application-level cleanup is
			// observable in the transaction log even if FK enforcement is
			// off; migration 041's FK ON DELETE CASCADE would catch any
			// row we miss, but the explicit DELETE is what the rest of
			// the byline domain expects to see.
			await trx.deleteFrom("_emdash_byline_field_values").where("byline_id", "=", id).execute();

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

			// Group-shared custom-field values are keyed by translation_group
			// (no FK to bylines), so they don't cascade with the byline row.
			// Clean them up explicitly so deleting the last sibling of an
			// identity doesn't leave orphan group values pointing at a
			// vanished translation group. Per-row translatable values
			// (`_emdash_byline_field_values` keyed by byline_id) already
			// cascaded when each sibling row was deleted, so no extra
			// cleanup is needed for that table.
			await trx
				.deleteFrom("_emdash_byline_field_group_values")
				.where("translation_group", "=", group)
				.execute();

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

		invalidateBylineObjectCache();
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
			.leftJoin("media as m", "m.id", "b.avatar_media_id")
			.select([
				"cb.sort_order as sort_order",
				"cb.role_label as role_label",
				"b.id as id",
				"b.slug as slug",
				"b.display_name as display_name",
				"b.bio as bio",
				"b.avatar_media_id as avatar_media_id",
				"m.storage_key as avatar_storage_key",
				"m.alt as avatar_alt",
				"m.blurhash as avatar_blurhash",
				"m.dominant_color as avatar_dominant_color",
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
		// Reconstruct byline rows to feed `withCustomFields`. The JOIN selects
		// the `BylineRow` columns under the `b.` alias plus the avatar media
		// columns from the `media` LEFT JOIN; carry both through so
		// `rowToByline` can populate `avatarStorageKey`/`avatarAlt` (otherwise
		// the join runs but its values are dropped here).
		const bylineRows: BylineRowWithAvatar[] = rows.map((row) => ({
			id: row.id,
			slug: row.slug,
			display_name: row.display_name,
			bio: row.bio,
			avatar_media_id: row.avatar_media_id,
			avatar_storage_key: row.avatar_storage_key,
			avatar_alt: row.avatar_alt,
			avatar_blurhash: row.avatar_blurhash,
			avatar_dominant_color: row.avatar_dominant_color,
			website_url: row.website_url,
			user_id: row.user_id,
			is_guest: row.is_guest,
			created_at: row.created_at,
			updated_at: row.updated_at,
			locale: row.locale,
			translation_group: row.translation_group,
		}));
		const hydrated = await this.withCustomFields(bylineRows);
		return rows.map((row, i) => {
			const byline = hydrated[i];
			if (!byline) {
				// Defensive: hydrated and rows are produced in lock-step;
				// this branch is unreachable unless `withCustomFields`
				// breaks its contract.
				throw new Error("getContentBylines: hydration row count mismatch");
			}
			return {
				byline,
				sortOrder: row.sort_order,
				roleLabel: row.role_label,
			};
		});
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
	 *
	 * When the caller will issue multiple `getContentBylinesMany` calls in
	 * one request (e.g. per locale bucket) and wants a *single* batched
	 * customFields hydration over the union of returned bylines, pass
	 * `skipHydration: true` on each call and finish with
	 * `hydrateBylineCustomFields(allBylines)`. The returned bylines carry
	 * `customFields = {}` until that hydration call runs — matching the
	 * "always populated" invariant from AC #6 — so callers that forget to
	 * hydrate get an empty map rather than `undefined`.
	 */
	async getContentBylinesMany(
		collectionSlug: string,
		contentIds: string[],
		options?: { locale?: string; skipHydration?: boolean },
	): Promise<Map<string, ContentBylineCredit[]>> {
		const result = new Map<string, ContentBylineCredit[]>();
		if (contentIds.length === 0) return result;

		const uniqueContentIds = [...new Set(contentIds)];
		for (const chunk of chunks(uniqueContentIds, SQL_BATCH_SIZE)) {
			let query = this.db
				.selectFrom("_emdash_content_bylines as cb")
				.innerJoin("_emdash_bylines as b", "b.translation_group", "cb.byline_id")
				.leftJoin("media as m", "m.id", "b.avatar_media_id")
				.select([
					"cb.content_id as content_id",
					"cb.sort_order as sort_order",
					"cb.role_label as role_label",
					"b.id as id",
					"b.slug as slug",
					"b.display_name as display_name",
					"b.bio as bio",
					"b.avatar_media_id as avatar_media_id",
					"m.storage_key as avatar_storage_key",
					"m.alt as avatar_alt",
					"m.blurhash as avatar_blurhash",
					"m.dominant_color as avatar_dominant_color",
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
			// Carry the avatar media columns from the LEFT JOIN through the
			// reshape so `rowToByline` can populate avatarStorageKey/avatarAlt.
			const bylineRows: BylineRowWithAvatar[] = rows.map((row) => ({
				id: row.id,
				slug: row.slug,
				display_name: row.display_name,
				bio: row.bio,
				avatar_media_id: row.avatar_media_id,
				avatar_storage_key: row.avatar_storage_key,
				avatar_alt: row.avatar_alt,
				avatar_blurhash: row.avatar_blurhash,
				avatar_dominant_color: row.avatar_dominant_color,
				website_url: row.website_url,
				user_id: row.user_id,
				is_guest: row.is_guest,
				created_at: row.created_at,
				updated_at: row.updated_at,
				locale: row.locale,
				translation_group: row.translation_group,
			}));

			// When `skipHydration` is set, return BylineSummary objects with
			// `customFields = {}`. The caller is responsible for batching
			// `hydrateBylineCustomFields` across multiple
			// `getContentBylinesMany` calls. Otherwise hydrate per-call —
			// the historical behaviour for solo callers.
			let bylines: BylineSummary[];
			if (options?.skipHydration === true) {
				bylines = bylineRows.map(rowToByline);
				for (const b of bylines) b.customFields = {};
			} else {
				bylines = await this.withCustomFields(bylineRows);
			}

			for (let i = 0; i < rows.length; i++) {
				const row = rows[i];
				const byline = bylines[i];
				if (!row || !byline) continue;
				const contentId = row.content_id;
				const credit: ContentBylineCredit = {
					byline,
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
	 *
	 * `skipHydration: true` returns bylines with `customFields = {}` so
	 * callers issuing multiple `findByUserIds` calls in one request (e.g.
	 * the per-locale-bucket author-fallback path in `getBylinesForEntries`)
	 * can defer customFields hydration to a single batched
	 * `hydrateBylineCustomFields` call across the union — keeping the
	 * Phase 3 query-count envelope at "+1 group-shared query per
	 * hydration pass" even when buckets fetch disjoint author bylines.
	 */
	async findByUserIds(
		userIds: string[],
		options?: { locale?: string; skipHydration?: boolean },
	): Promise<Map<string, BylineSummary>> {
		const result = new Map<string, BylineSummary>();
		if (userIds.length === 0) return result;

		for (const chunk of chunks(userIds, SQL_BATCH_SIZE)) {
			// LEFT JOIN media so author-inferred bylines (the fallback path in
			// `getBylinesForEntries`) carry the same render-ready avatar storage
			// key as explicitly-credited bylines do.
			let query = this.db
				.selectFrom("_emdash_bylines as b")
				.leftJoin("media as m", "m.id", "b.avatar_media_id")
				.select([
					"b.id as id",
					"b.slug as slug",
					"b.display_name as display_name",
					"b.bio as bio",
					"b.avatar_media_id as avatar_media_id",
					"m.storage_key as avatar_storage_key",
					"m.alt as avatar_alt",
					"m.blurhash as avatar_blurhash",
					"m.dominant_color as avatar_dominant_color",
					"b.website_url as website_url",
					"b.user_id as user_id",
					"b.is_guest as is_guest",
					"b.created_at as created_at",
					"b.updated_at as updated_at",
					"b.locale as locale",
					"b.translation_group as translation_group",
				])
				.where("b.user_id", "in", chunk);
			if (options?.locale !== undefined) query = query.where("b.locale", "=", options.locale);

			const rows = await query.execute();
			let bylines: BylineSummary[];
			if (options?.skipHydration === true) {
				bylines = rows.map(rowToByline);
				for (const b of bylines) b.customFields = {};
			} else {
				bylines = await this.withCustomFields(rows);
			}

			for (let i = 0; i < rows.length; i++) {
				const row = rows[i];
				const summary = bylines[i];
				if (!row || !summary || !row.user_id) continue;
				result.set(row.user_id, summary);
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

		// Byline credits are folded into the target entry's cached payload.
		invalidateCollectionCache(collection);
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

		// Byline credits are folded into this entry's cached payload.
		invalidateCollectionCache(collectionSlug);

		return await this.getContentBylines(collectionSlug, contentId);
	}
}
