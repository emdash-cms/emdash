import type { Kysely, Selectable } from "kysely";
import { ulid } from "ulidx";

import type { Database, TaxonomyTable, ContentTaxonomyTable } from "../types.js";

export interface Taxonomy {
	id: string;
	name: string;
	slug: string;
	label: string;
	parentId: string | null;
	data: Record<string, unknown> | null;
	locale: string;
	translationGroup: string | null;
}

export interface CreateTaxonomyInput {
	name: string;
	slug: string;
	label: string;
	parentId?: string;
	data?: Record<string, unknown>;
	/** Omit to let the DB default (current value: 'en') apply. Higher layers
	 * resolve the locale from the request context / i18n config. */
	locale?: string;
	/** When set, links the new term into the source term's translation_group. */
	translationOf?: string;
}

export interface UpdateTaxonomyInput {
	slug?: string;
	label?: string;
	parentId?: string | null;
	data?: Record<string, unknown>;
}

export interface FindOptions {
	parentId?: string | null;
	locale?: string;
}

/**
 * Taxonomy repository for categories, tags, and other classification.
 *
 * Terms are per-locale. Translations of the same term share a `translation_group`
 * ULID. `content_taxonomies.taxonomy_id` stores the translation_group so a single
 * association spans every locale of a post.
 *
 * The repository does not resolve locale fallbacks on its own — callers supply
 * the locale they want. Runtime helpers and handlers use `getFallbackChain()`
 * from `i18n/config` when they need fallback behaviour.
 */
export class TaxonomyRepository {
	constructor(private db: Kysely<Database>) {}

	/**
	 * Create a new taxonomy term. When `translationOf` is set the new row joins
	 * the source term's translation_group; otherwise a fresh group is minted
	 * (matching the migration backfill pattern `translation_group = id`).
	 */
	async create(input: CreateTaxonomyInput): Promise<Taxonomy> {
		const id = ulid();

		// Empty-string parentId is coerced to null defensively. Higher layers
		// also normalize this — see handleTermCreate / handleTermUpdate.
		const parentId = input.parentId === undefined || input.parentId === "" ? null : input.parentId;

		let translationGroup = id;
		if (input.translationOf) {
			const source = await this.findById(input.translationOf);
			if (source?.translationGroup) translationGroup = source.translationGroup;
		}

		await this.db
			.insertInto("taxonomies")
			.values({
				id,
				name: input.name,
				slug: input.slug,
				label: input.label,
				parent_id: parentId,
				data: input.data ? JSON.stringify(input.data) : null,
				// When omitted, the DB DEFAULT 'en' is used — keeps behaviour
				// consistent with ContentRepository and lets higher layers
				// supply an explicit locale from request context.
				...(input.locale !== undefined ? { locale: input.locale } : {}),
				translation_group: translationGroup,
			})
			.execute();

		const taxonomy = await this.findById(id);
		if (!taxonomy) throw new Error("Failed to create taxonomy");
		return taxonomy;
	}

	async findById(id: string): Promise<Taxonomy | null> {
		const row = await this.db
			.selectFrom("taxonomies")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		return row ? this.rowToTaxonomy(row) : null;
	}

	/**
	 * Find a term by (name, slug). When `locale` is provided, filter by it.
	 * When omitted, returns the lowest-locale-code match (deterministic across
	 * calls). Mirrors `ContentRepository.findBySlug`.
	 */
	async findBySlug(name: string, slug: string, locale?: string): Promise<Taxonomy | null> {
		let query = this.db
			.selectFrom("taxonomies")
			.selectAll()
			.where("name", "=", name)
			.where("slug", "=", slug);
		if (locale !== undefined) query = query.where("locale", "=", locale);
		const row = await query.orderBy("locale", "asc").executeTakeFirst();
		return row ? this.rowToTaxonomy(row) : null;
	}

	/**
	 * Get all terms for a taxonomy (e.g., all categories).
	 *
	 * `id asc` is a stable tiebreaker for terms that share a label. Without it
	 * the SQL ordering is implementation-defined when labels match, which
	 * breaks keyset pagination over `(label, id)`.
	 */
	async findByName(name: string, options: FindOptions = {}): Promise<Taxonomy[]> {
		let query = this.db
			.selectFrom("taxonomies")
			.selectAll()
			.where("name", "=", name)
			.orderBy("label", "asc")
			.orderBy("id", "asc");

		if (options.locale !== undefined) query = query.where("locale", "=", options.locale);

		if (options.parentId !== undefined) {
			if (options.parentId === null) {
				query = query.where("parent_id", "is", null);
			} else {
				query = query.where("parent_id", "=", options.parentId);
			}
		}

		const rows = await query.execute();
		return rows.map((row) => this.rowToTaxonomy(row));
	}

	async findChildren(parentId: string): Promise<Taxonomy[]> {
		const rows = await this.db
			.selectFrom("taxonomies")
			.selectAll()
			.where("parent_id", "=", parentId)
			.orderBy("label", "asc")
			.orderBy("id", "asc")
			.execute();
		return rows.map((row) => this.rowToTaxonomy(row));
	}

	/**
	 * Every translation sibling of a term (including itself), identified by
	 * their shared `translation_group`.
	 */
	async findTranslations(translationGroup: string): Promise<Taxonomy[]> {
		const rows = await this.db
			.selectFrom("taxonomies")
			.selectAll()
			.where("translation_group", "=", translationGroup)
			.orderBy("locale", "asc")
			.execute();
		return rows.map((row) => this.rowToTaxonomy(row));
	}

	async update(id: string, input: UpdateTaxonomyInput): Promise<Taxonomy | null> {
		const existing = await this.findById(id);
		if (!existing) return null;

		const updates: Record<string, unknown> = {};
		if (input.slug !== undefined) updates.slug = input.slug;
		if (input.label !== undefined) updates.label = input.label;
		if (input.parentId !== undefined) {
			// Defense in depth: empty-string parentId means null (no parent).
			updates.parent_id = input.parentId === "" ? null : input.parentId;
		}
		if (input.data !== undefined) updates.data = JSON.stringify(input.data);

		if (Object.keys(updates).length > 0) {
			await this.db.updateTable("taxonomies").set(updates).where("id", "=", id).execute();
		}

		return this.findById(id);
	}

	async delete(id: string): Promise<boolean> {
		const term = await this.findById(id);
		if (!term) return false;

		// When deleting the last translation of a group the pivot rows that
		// reference that translation_group become orphaned — purge them.
		if (term.translationGroup) {
			const siblings = await this.db
				.selectFrom("taxonomies")
				.select("id")
				.where("translation_group", "=", term.translationGroup)
				.where("id", "!=", id)
				.execute();
			if (siblings.length === 0) {
				await this.db
					.deleteFrom("content_taxonomies")
					.where("taxonomy_id", "=", term.translationGroup)
					.execute();
			}
		}

		const result = await this.db.deleteFrom("taxonomies").where("id", "=", id).executeTakeFirst();
		return (result.numDeletedRows ?? 0n) > 0n;
	}

	// --- Content-Taxonomy Junction (taxonomy_id stores the translation_group) ---

	async attachToEntry(collection: string, entryId: string, taxonomyId: string): Promise<void> {
		const group = await this.resolveTranslationGroup(taxonomyId);
		if (!group) return;

		const row: ContentTaxonomyTable = {
			collection,
			entry_id: entryId,
			taxonomy_id: group,
		};
		await this.db
			.insertInto("content_taxonomies")
			.values(row)
			.onConflict((oc) => oc.doNothing())
			.execute();
	}

	async detachFromEntry(collection: string, entryId: string, taxonomyId: string): Promise<void> {
		const group = await this.resolveTranslationGroup(taxonomyId);
		if (!group) return;

		await this.db
			.deleteFrom("content_taxonomies")
			.where("collection", "=", collection)
			.where("entry_id", "=", entryId)
			.where("taxonomy_id", "=", group)
			.execute();
	}

	/**
	 * Taxonomy terms assigned to a content entry, resolved into a specific locale.
	 * Terms whose translation_group lacks a row in the requested locale are
	 * omitted — callers wanting fallback behaviour apply it themselves.
	 */
	async getTermsForEntry(
		collection: string,
		entryId: string,
		taxonomyName?: string,
		locale?: string,
	): Promise<Taxonomy[]> {
		let query = this.db
			.selectFrom("content_taxonomies")
			.innerJoin("taxonomies", "taxonomies.translation_group", "content_taxonomies.taxonomy_id")
			.selectAll("taxonomies")
			.where("content_taxonomies.collection", "=", collection)
			.where("content_taxonomies.entry_id", "=", entryId);

		if (taxonomyName) query = query.where("taxonomies.name", "=", taxonomyName);
		if (locale !== undefined) query = query.where("taxonomies.locale", "=", locale);

		const rows = await query.orderBy("taxonomies.locale", "asc").execute();
		return rows.map((row) => this.rowToTaxonomy(row));
	}

	/**
	 * Replace all assignments of a given taxonomy for one content entry.
	 * Term ids OR translation_groups are accepted and normalised to groups.
	 */
	async setTermsForEntry(
		collection: string,
		entryId: string,
		taxonomyName: string,
		termIds: string[],
	): Promise<void> {
		const groups: string[] = [];
		for (const id of termIds) {
			const group = await this.resolveTranslationGroup(id);
			if (group) groups.push(group);
		}
		const newGroups = new Set(groups);

		const current = await this.db
			.selectFrom("content_taxonomies")
			.innerJoin("taxonomies", "taxonomies.translation_group", "content_taxonomies.taxonomy_id")
			.select(["content_taxonomies.taxonomy_id as group"])
			.distinct()
			.where("content_taxonomies.collection", "=", collection)
			.where("content_taxonomies.entry_id", "=", entryId)
			.where("taxonomies.name", "=", taxonomyName)
			.execute();
		const currentGroups = new Set(current.map((r) => r.group));

		const toRemove = [...currentGroups].filter((g) => !newGroups.has(g));
		if (toRemove.length > 0) {
			await this.db
				.deleteFrom("content_taxonomies")
				.where("collection", "=", collection)
				.where("entry_id", "=", entryId)
				.where("taxonomy_id", "in", toRemove)
				.execute();
		}

		const toAdd = [...newGroups].filter((g) => !currentGroups.has(g));
		if (toAdd.length > 0) {
			await this.db
				.insertInto("content_taxonomies")
				.values(
					toAdd.map((taxonomy_id) => ({
						collection,
						entry_id: entryId,
						taxonomy_id,
					})),
				)
				.onConflict((oc) => oc.doNothing())
				.execute();
		}
	}

	async clearEntryTerms(collection: string, entryId: string): Promise<number> {
		const result = await this.db
			.deleteFrom("content_taxonomies")
			.where("collection", "=", collection)
			.where("entry_id", "=", entryId)
			.executeTakeFirst();
		return Number(result.numDeletedRows ?? 0);
	}

	/**
	 * Copy every term assignment from one content entry to another. Used when
	 * creating a translation of a post so the new translation inherits the
	 * source's term assignments. Safe to call when the source has no terms.
	 */
	async copyEntryTerms(
		collection: string,
		sourceEntryId: string,
		targetEntryId: string,
	): Promise<void> {
		const rows = await this.db
			.selectFrom("content_taxonomies")
			.select(["taxonomy_id"])
			.where("collection", "=", collection)
			.where("entry_id", "=", sourceEntryId)
			.execute();
		if (rows.length === 0) return;

		await this.db
			.insertInto("content_taxonomies")
			.values(
				rows.map((r) => ({
					collection,
					entry_id: targetEntryId,
					taxonomy_id: r.taxonomy_id,
				})),
			)
			.onConflict((oc) => oc.doNothing())
			.execute();
	}

	/**
	 * Count content entries that use any translation of this term. Accepts
	 * either a term id or a translation_group — we normalise to the group.
	 */
	async countEntriesWithTerm(termIdOrGroup: string): Promise<number> {
		const group = await this.resolveTranslationGroup(termIdOrGroup);
		if (!group) return 0;

		const result = await this.db
			.selectFrom("content_taxonomies")
			.select((eb) => eb.fn.count("entry_id").as("count"))
			.where("taxonomy_id", "=", group)
			.executeTakeFirst();
		return Number(result?.count ?? 0);
	}

	private async resolveTranslationGroup(idOrGroup: string): Promise<string | null> {
		const row = await this.db
			.selectFrom("taxonomies")
			.select(["translation_group"])
			.where((eb) => eb.or([eb("id", "=", idOrGroup), eb("translation_group", "=", idOrGroup)]))
			.executeTakeFirst();
		return row?.translation_group ?? null;
	}

	/**
	 * Batch count entries for multiple taxonomy translation_groups.
	 * Chunks the query at SQL_BATCH_SIZE to stay below D1's bind-parameter limit.
	 * Returns a Map from translation_group to count.
	 *
	 * Pass translation_groups (not term ids) — `content_taxonomies.taxonomy_id`
	 * stores the translation_group so a single assignment spans every locale.
	 */
	async countEntriesForTerms(translationGroups: string[]): Promise<Map<string, number>> {
		if (translationGroups.length === 0) return new Map();

		const { chunks, SQL_BATCH_SIZE } = await import("../../utils/chunks.js");

		const counts = new Map<string, number>();
		for (const chunk of chunks(translationGroups, SQL_BATCH_SIZE)) {
			const rows = await this.db
				.selectFrom("content_taxonomies")
				.select(["taxonomy_id", (eb) => eb.fn.count("entry_id").as("count")])
				.where("taxonomy_id", "in", chunk)
				.groupBy("taxonomy_id")
				.execute();

			for (const row of rows) {
				counts.set(row.taxonomy_id, Number(row.count || 0));
			}
		}
		return counts;
	}

	private rowToTaxonomy(row: Selectable<TaxonomyTable>): Taxonomy {
		return {
			id: row.id,
			name: row.name,
			slug: row.slug,
			label: row.label,
			parentId: row.parent_id,
			data: row.data ? JSON.parse(row.data) : null,
			locale: row.locale,
			translationGroup: row.translation_group,
		};
	}
}
