import type { Kysely, Selectable } from "kysely";
import { ulid } from "ulidx";

import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import type { Database, RelationTable, ContentReferenceTable } from "../types.js";
import { decodeCursor, encodeCursor, InvalidCursorError, type FindManyResult } from "./types.js";

export interface Relation {
	id: string;
	name: string;
	parentCollection: string;
	childCollection: string;
	parentLabel: string;
	childLabel: string;
	locale: string;
	translationGroup: string;
}

export interface CreateRelationInput {
	name: string;
	parentCollection: string;
	childCollection: string;
	parentLabel: string;
	childLabel: string;
	/** Omit to let the DB default (current value: 'en') apply. Higher layers
	 * resolve locale from request context / i18n config. */
	locale?: string;
	/** When set, joins the source relation's translation_group AND inherits its
	 * structural fields (name, parentCollection, childCollection). Only locale +
	 * labels may differ on a translation. */
	translationOf?: string;
}

export interface UpdateRelationInput {
	/** Only localized fields are mutable per row. Changing structural fields
	 * (name/collections) is a cross-group operation deferred to a later slice. */
	parentLabel?: string;
	childLabel?: string;
}

export interface ContentReference {
	id: string;
	relationGroup: string;
	parentGroup: string;
	childGroup: string;
	sortOrder: number;
}

/**
 * Content-references repository.
 *
 * Owns relation *definitions* (`_emdash_relations`, row-per-locale, mirroring
 * `_emdash_taxonomy_defs`) and the *edge* junction (`_emdash_content_references`,
 * keyed by `translation_group` so edges are locale-agnostic, mirroring
 * `content_taxonomies`).
 *
 * Like `TaxonomyRepository`, this is not the validation boundary: it trusts its
 * typed inputs. The API slice supplies Zod schemas at the route and enforces
 * collection-agreement / relation-existence invariants in the handler. The repo
 * does not resolve locale fallbacks — callers pass the locale they want.
 */
export class RelationRepository {
	constructor(private db: Kysely<Database>) {}

	/**
	 * Create a relation. Without `translationOf`, mints a fresh group
	 * (`translation_group = id`, matching the migration backfill pattern). With
	 * `translationOf`, the structural fields (name, parentCollection,
	 * childCollection) and the translation_group are inherited from the source;
	 * locale and the two labels are taken from `input`.
	 */
	async create(input: CreateRelationInput): Promise<Relation> {
		const id = ulid();
		const now = new Date().toISOString();

		let translationGroup = id;
		let name = input.name;
		let parentCollection = input.parentCollection;
		let childCollection = input.childCollection;

		if (input.translationOf) {
			const source = await this.findById(input.translationOf);
			// translation_group is NOT NULL here, so we cannot fall back to a
			// fresh group like TaxonomyRepository does — a bad translationOf must
			// fail loudly rather than silently mint an unlinked relation.
			if (!source) throw new Error("Source relation for translation not found");
			translationGroup = source.translationGroup;
			name = source.name;
			parentCollection = source.parentCollection;
			childCollection = source.childCollection;
		}

		await this.db
			.insertInto("_emdash_relations")
			.values({
				id,
				name,
				parent_collection: parentCollection,
				child_collection: childCollection,
				parent_label: input.parentLabel,
				child_label: input.childLabel,
				created_at: now,
				updated_at: now,
				// Omit `locale` so the DB DEFAULT (configured defaultLocale)
				// applies — matches TaxonomyRepository.create.
				...(input.locale !== undefined ? { locale: input.locale } : {}),
				translation_group: translationGroup,
			})
			.execute();

		const relation = await this.findById(id);
		if (!relation) throw new Error("Failed to create relation");
		return relation;
	}

	async findById(id: string): Promise<Relation | null> {
		const row = await this.db
			.selectFrom("_emdash_relations")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		return row ? this.rowToRelation(row) : null;
	}

	/**
	 * Find a relation by name. With `locale`, filter by it; without, return the
	 * lowest-locale-code match deterministically. Mirrors
	 * `TaxonomyRepository.findBySlug` — note this returns a single row, unlike
	 * `TaxonomyRepository.findByName` which returns every term in a taxonomy.
	 */
	async findByName(name: string, locale?: string): Promise<Relation | null> {
		let query = this.db.selectFrom("_emdash_relations").selectAll().where("name", "=", name);
		if (locale !== undefined) query = query.where("locale", "=", locale);
		const row = await query.orderBy("locale", "asc").executeTakeFirst();
		return row ? this.rowToRelation(row) : null;
	}

	/** Every translation sibling (including itself) sharing a translation_group. */
	async findTranslations(translationGroup: string): Promise<Relation[]> {
		const rows = await this.db
			.selectFrom("_emdash_relations")
			.selectAll()
			.where("translation_group", "=", translationGroup)
			.orderBy("locale", "asc")
			.execute();
		return rows.map((row) => this.rowToRelation(row));
	}

	/**
	 * All relations, ordered by name then id (id is a stable tiebreak for
	 * relations sharing a name across locales). Optionally filtered by locale.
	 */
	async list(locale?: string): Promise<Relation[]> {
		let query = this.db
			.selectFrom("_emdash_relations")
			.selectAll()
			.orderBy("name", "asc")
			.orderBy("id", "asc");
		if (locale !== undefined) query = query.where("locale", "=", locale);
		const rows = await query.execute();
		return rows.map((row) => this.rowToRelation(row));
	}

	/** Relations where `collection` is the parent OR the child side. */
	async findForCollection(collection: string, locale?: string): Promise<Relation[]> {
		let query = this.db
			.selectFrom("_emdash_relations")
			.selectAll()
			.where((eb) =>
				eb.or([eb("parent_collection", "=", collection), eb("child_collection", "=", collection)]),
			)
			.orderBy("name", "asc")
			.orderBy("id", "asc");
		if (locale !== undefined) query = query.where("locale", "=", locale);
		const rows = await query.execute();
		return rows.map((row) => this.rowToRelation(row));
	}

	/**
	 * Update the localized labels of one relation row. Structural fields are
	 * immutable here (a cross-group concern). No-ops when nothing is supplied.
	 */
	async update(id: string, input: UpdateRelationInput): Promise<Relation | null> {
		const existing = await this.findById(id);
		if (!existing) return null;

		const updates: Record<string, unknown> = {};
		if (input.parentLabel !== undefined) updates.parent_label = input.parentLabel;
		if (input.childLabel !== undefined) updates.child_label = input.childLabel;

		if (Object.keys(updates).length > 0) {
			updates.updated_at = new Date().toISOString();
			await this.db.updateTable("_emdash_relations").set(updates).where("id", "=", id).execute();
		}

		return this.findById(id);
	}

	/**
	 * Delete one relation row. When it is the *last* translation of its group,
	 * purge edges referencing that group (application-layer cascade — group
	 * linking precludes a SQL FK). Mirrors `TaxonomyRepository.delete`.
	 */
	async delete(id: string): Promise<boolean> {
		const relation = await this.findById(id);
		if (!relation) return false;

		const siblings = await this.db
			.selectFrom("_emdash_relations")
			.select("id")
			.where("translation_group", "=", relation.translationGroup)
			.where("id", "!=", id)
			.execute();
		if (siblings.length === 0) {
			await this.db
				.deleteFrom("_emdash_content_references")
				.where("relation_group", "=", relation.translationGroup)
				.execute();
		}

		const result = await this.db
			.deleteFrom("_emdash_relations")
			.where("id", "=", id)
			.executeTakeFirst();
		return (result.numDeletedRows ?? 0n) > 0n;
	}

	/** Normalize a relation id OR group to its translation_group. Returns null
	 * for an unknown relation (edge methods then no-op, matching
	 * `TaxonomyRepository.attachToEntry`). */
	private async resolveRelationGroup(idOrGroup: string): Promise<string | null> {
		const row = await this.db
			.selectFrom("_emdash_relations")
			.select(["translation_group"])
			.where((eb) => eb.or([eb("id", "=", idOrGroup), eb("translation_group", "=", idOrGroup)]))
			.executeTakeFirst();
		return row?.translation_group ?? null;
	}

	private rowToReference(row: Selectable<ContentReferenceTable>): ContentReference {
		return {
			id: row.id,
			relationGroup: row.relation_group,
			parentGroup: row.parent_group,
			childGroup: row.child_group,
			sortOrder: row.sort_order,
		};
	}

	/**
	 * Link `parentGroup → childGroup` under a relation. `relation` is a relation
	 * id or group. Idempotent (onConflict doNothing against the unique edge).
	 * `sortOrder` defaults to append: max(sort_order)+1 within (relation, parent).
	 *
	 * The default-append MAX→INSERT is not atomic: concurrent appends without an
	 * explicit `sortOrder` may both read the same max and collide on sort_order,
	 * and onConflict silently drops the loser. Callers needing strict ordering
	 * under concurrency should pass `sortOrder` explicitly (or serialize).
	 */
	async addReference(
		relation: string,
		parentGroup: string,
		childGroup: string,
		sortOrder?: number,
	): Promise<void> {
		const relationGroup = await this.resolveRelationGroup(relation);
		if (!relationGroup) return;

		let order = sortOrder;
		if (order === undefined) {
			const max = await this.db
				.selectFrom("_emdash_content_references")
				.select((eb) => eb.fn.max("sort_order").as("max"))
				.where("relation_group", "=", relationGroup)
				.where("parent_group", "=", parentGroup)
				.executeTakeFirst();
			order = max?.max === null || max?.max === undefined ? 0 : Number(max.max) + 1;
		}

		await this.db
			.insertInto("_emdash_content_references")
			.values({
				id: ulid(),
				relation_group: relationGroup,
				parent_group: parentGroup,
				child_group: childGroup,
				sort_order: order,
				created_at: new Date().toISOString(),
			})
			.onConflict((oc) => oc.doNothing())
			.execute();
	}

	/** Remove one `parentGroup → childGroup` edge under a relation. */
	async removeReference(relation: string, parentGroup: string, childGroup: string): Promise<void> {
		const relationGroup = await this.resolveRelationGroup(relation);
		if (!relationGroup) return;

		await this.db
			.deleteFrom("_emdash_content_references")
			.where("relation_group", "=", relationGroup)
			.where("parent_group", "=", parentGroup)
			.where("child_group", "=", childGroup)
			.execute();
	}

	/** Forward traversal: a parent's children for a relation, ordered. */
	async getChildren(relation: string, parentGroup: string): Promise<ContentReference[]> {
		const relationGroup = await this.resolveRelationGroup(relation);
		if (!relationGroup) return [];

		const rows = await this.db
			.selectFrom("_emdash_content_references")
			.selectAll()
			.where("relation_group", "=", relationGroup)
			.where("parent_group", "=", parentGroup)
			.orderBy("sort_order", "asc")
			.orderBy("id", "asc")
			.execute();
		return rows.map((row) => this.rowToReference(row));
	}

	/**
	 * Forward traversal, paginated: one page of a parent's children for a
	 * relation, ordered by `(sort_order, id)`. Use this on request paths — a
	 * parent's children are capped but still up to 1000, and an unbounded read
	 * scales poorly. Returns `{ items, nextCursor? }`; the cursor's order value is
	 * the row's `sort_order`. Default limit 50, max 100.
	 */
	async getChildrenPage(
		relation: string,
		parentGroup: string,
		options: { limit?: number; cursor?: string } = {},
	): Promise<FindManyResult<ContentReference>> {
		const relationGroup = await this.resolveRelationGroup(relation);
		if (!relationGroup) return { items: [] };

		const limit = Math.min(options.limit || 50, 100);

		let query = this.db
			.selectFrom("_emdash_content_references")
			.selectAll()
			.where("relation_group", "=", relationGroup)
			.where("parent_group", "=", parentGroup);

		if (options.cursor) {
			const decoded = decodeCursor(options.cursor);
			const sortOrder = Number(decoded.orderValue);
			// `decodeCursor` only guarantees `orderValue` is a string; a hand-crafted
			// cursor with a non-numeric order value would coerce to NaN and blow up at
			// the driver bind as a 500. A bad cursor is a client error — surface it as
			// INVALID_CURSOR (400). Server-issued cursors are always numeric here.
			if (!Number.isFinite(sortOrder)) throw new InvalidCursorError(options.cursor);
			query = query.where((eb) =>
				eb.or([
					eb("sort_order", ">", sortOrder),
					eb.and([eb("sort_order", "=", sortOrder), eb("id", ">", decoded.id)]),
				]),
			);
		}

		const rows = await query
			.orderBy("sort_order", "asc")
			.orderBy("id", "asc")
			.limit(limit + 1)
			.execute();

		const hasMore = rows.length > limit;
		const items = rows.slice(0, limit).map((row) => this.rowToReference(row));
		const result: FindManyResult<ContentReference> = { items };
		const last = items.at(-1);
		if (hasMore && last) {
			result.nextCursor = encodeCursor(String(last.sortOrder), last.id);
		}
		return result;
	}

	/** Backlink traversal: the parents that reference a child for a relation. */
	async getParents(relation: string, childGroup: string): Promise<ContentReference[]> {
		const relationGroup = await this.resolveRelationGroup(relation);
		if (!relationGroup) return [];

		const rows = await this.db
			.selectFrom("_emdash_content_references")
			.selectAll()
			.where("relation_group", "=", relationGroup)
			.where("child_group", "=", childGroup)
			.orderBy("id", "asc")
			.execute();
		return rows.map((row) => this.rowToReference(row));
	}

	/**
	 * Replace all children of `parentGroup` under a relation with `childGroups`,
	 * assigning positional sort_order (index in the deduped array). Deletes the
	 * old set for this (relation, parent) and re-inserts — simple and correct;
	 * the set is small (one parent's children). Mirrors the intent of
	 * `TaxonomyRepository.setTermsForEntry`.
	 *
	 * A parent references a given child at most once (the unique edge), so
	 * duplicate `childGroups` are collapsed first-occurrence-wins rather than
	 * relying on the insert's onConflict to silently drop them. Not wrapped in a
	 * transaction: a crash between the delete and insert leaves the parent with
	 * no children — acceptable for a replace-all, since a retry restores state.
	 *
	 * Concurrency: two simultaneous replace-all calls for the same (relation,
	 * parent) can interleave their deletes and inserts and merge into the union of
	 * both sets (a lost update — neither "replace" wins). This is non-corrupting —
	 * keyset pagination stays totally ordered via the `(sort_order, id)` tiebreak
	 * even with duplicate sort_orders — and a single client editing one parent's
	 * children serially never hits it. A D1-portable fix isn't available (no
	 * multi-statement transactions), so concurrent replace-all on one parent is
	 * unsupported by design rather than guarded here.
	 */
	async setChildren(relation: string, parentGroup: string, childGroups: string[]): Promise<void> {
		const relationGroup = await this.resolveRelationGroup(relation);
		if (!relationGroup) return;

		await this.db
			.deleteFrom("_emdash_content_references")
			.where("relation_group", "=", relationGroup)
			.where("parent_group", "=", parentGroup)
			.execute();

		// Collapse duplicates so positional sort_order has no gaps.
		const uniqueChildGroups = [...new Set(childGroups)];
		if (uniqueChildGroups.length === 0) return;

		const now = new Date().toISOString();
		await this.db
			.insertInto("_emdash_content_references")
			.values(
				uniqueChildGroups.map((childGroup, index) => ({
					id: ulid(),
					relation_group: relationGroup,
					parent_group: parentGroup,
					child_group: childGroup,
					sort_order: index,
					created_at: now,
				})),
			)
			// Belt-and-suspenders: the DELETE above already cleared this
			// (relation, parent), so no conflict is possible within one call.
			// This is NOT a concurrency guarantee — delete-then-insert is not atomic.
			.onConflict((oc) => oc.doNothing())
			.execute();
	}

	/**
	 * Backlink traversal, paginated: one page of the parents that reference a
	 * child for a relation, ordered by `id`. Unlike a parent's children, a
	 * child's backlinks are *unbounded* — one popular entry can be referenced by
	 * arbitrarily many parents — so this read must paginate. Returns
	 * `{ items, nextCursor? }`; the cursor's order value is the row `id`. Default
	 * limit 50, max 100.
	 */
	async getParentsPage(
		relation: string,
		childGroup: string,
		options: { limit?: number; cursor?: string } = {},
	): Promise<FindManyResult<ContentReference>> {
		const relationGroup = await this.resolveRelationGroup(relation);
		if (!relationGroup) return { items: [] };

		const limit = Math.min(options.limit || 50, 100);

		let query = this.db
			.selectFrom("_emdash_content_references")
			.selectAll()
			.where("relation_group", "=", relationGroup)
			.where("child_group", "=", childGroup);

		if (options.cursor) {
			const decoded = decodeCursor(options.cursor);
			query = query.where("id", ">", decoded.id);
		}

		const rows = await query
			.orderBy("id", "asc")
			.limit(limit + 1)
			.execute();

		const hasMore = rows.length > limit;
		const items = rows.slice(0, limit).map((row) => this.rowToReference(row));
		const result: FindManyResult<ContentReference> = { items };
		const last = items.at(-1);
		if (hasMore && last) {
			result.nextCursor = encodeCursor(last.id, last.id);
		}
		return result;
	}

	/**
	 * Remove every edge where `group` is the parent OR the child — i.e. ensure no
	 * orphaned reference edges survive when a content entry is deleted. The
	 * application-layer cascade that group-linking precludes at the SQL level.
	 * Wiring this into the content-delete path is a later (handler) slice.
	 * Returns the number of edges removed.
	 */
	async clearReferencesForGroup(group: string): Promise<number> {
		const result = await this.db
			.deleteFrom("_emdash_content_references")
			.where((eb) => eb.or([eb("parent_group", "=", group), eb("child_group", "=", group)]))
			.executeTakeFirst();
		return Number(result.numDeletedRows ?? 0);
	}

	/** Count a parent's children under a relation. */
	async countChildren(relation: string, parentGroup: string): Promise<number> {
		const relationGroup = await this.resolveRelationGroup(relation);
		if (!relationGroup) return 0;
		const result = await this.db
			.selectFrom("_emdash_content_references")
			.select((eb) => eb.fn.count("id").as("count"))
			.where("relation_group", "=", relationGroup)
			.where("parent_group", "=", parentGroup)
			.executeTakeFirst();
		return Number(result?.count ?? 0);
	}

	/** Count a child's parents (backlinks) under a relation. */
	async countParents(relation: string, childGroup: string): Promise<number> {
		const relationGroup = await this.resolveRelationGroup(relation);
		if (!relationGroup) return 0;
		const result = await this.db
			.selectFrom("_emdash_content_references")
			.select((eb) => eb.fn.count("id").as("count"))
			.where("relation_group", "=", relationGroup)
			.where("child_group", "=", childGroup)
			.executeTakeFirst();
		return Number(result?.count ?? 0);
	}

	/**
	 * Batch child-counts for many parents under a relation. Chunks at
	 * SQL_BATCH_SIZE for D1's bind-parameter limit. Returns parent_group → count
	 * (parents with no children are absent from the map). Mirrors
	 * `TaxonomyRepository.countEntriesForTerms`.
	 */
	async countChildrenForParents(
		relation: string,
		parentGroups: string[],
	): Promise<Map<string, number>> {
		const counts = new Map<string, number>();
		if (parentGroups.length === 0) return counts;
		const relationGroup = await this.resolveRelationGroup(relation);
		if (!relationGroup) return counts;

		for (const chunk of chunks(parentGroups, SQL_BATCH_SIZE)) {
			const rows = await this.db
				.selectFrom("_emdash_content_references")
				.select(["parent_group", (eb) => eb.fn.count("id").as("count")])
				.where("relation_group", "=", relationGroup)
				.where("parent_group", "in", chunk)
				.groupBy("parent_group")
				.execute();
			for (const row of rows) {
				counts.set(row.parent_group, Number(row.count ?? 0));
			}
		}
		return counts;
	}

	private rowToRelation(row: Selectable<RelationTable>): Relation {
		return {
			id: row.id,
			name: row.name,
			parentCollection: row.parent_collection,
			childCollection: row.child_collection,
			parentLabel: row.parent_label,
			childLabel: row.child_label,
			locale: row.locale,
			translationGroup: row.translation_group,
		};
	}
}
