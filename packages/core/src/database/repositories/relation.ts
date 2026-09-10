import type { Kysely, Selectable } from "kysely";
import { ulid } from "ulidx";

import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import type { Database, RelationTable, ContentReferenceTable } from "../types.js";
import { decodeCursor, encodeCursor, InvalidCursorError, type FindManyResult } from "./types.js";

// Each reference-edge row binds six values. Derive the row count so every
// INSERT stays within D1's 100-parameter statement ceiling.
const REFERENCE_INSERT_BIND_COLUMNS = 6;
const D1_MAX_BOUND_PARAMETERS = 100;
const REFERENCE_INSERT_BATCH_SIZE = Math.floor(
	D1_MAX_BOUND_PARAMETERS / REFERENCE_INSERT_BIND_COLUMNS,
);

/**
 * A relation definition. Not localized: a relation joins the same two
 * collections whatever language you read it in, and its role labels are
 * single-valued like a collection's or a field's. That is what lets `slug` be
 * unique outright (migration 076) and resolve without a locale.
 */
export interface Relation {
	id: string;
	slug: string;
	parentCollection: string;
	childCollection: string;
	parentLabel: string;
	childLabel: string;
	parentLabelSingular: string | null;
	childLabelSingular: string | null;
	/** How many children one parent may hold. `null` means unlimited. */
	maxChildrenPerParent: number | null;
	/** How many parents one child may hold. `null` means unlimited. */
	maxParentsPerChild: number | null;
}

export interface CreateRelationInput {
	slug: string;
	parentCollection: string;
	childCollection: string;
	parentLabel: string;
	childLabel: string;
	parentLabelSingular?: string | null;
	childLabelSingular?: string | null;
	maxChildrenPerParent?: number | null;
	maxParentsPerChild?: number | null;
}

export interface UpdateRelationInput {
	/** Structural fields are immutable: a reference field stores the slug, and
	 * the edges are keyed by the id. */
	parentLabel?: string;
	childLabel?: string;
	parentLabelSingular?: string | null;
	childLabelSingular?: string | null;
	maxChildrenPerParent?: number | null;
	maxParentsPerChild?: number | null;
}

export interface ContentReference {
	id: string;
	relationId: string;
	parentGroup: string;
	childGroup: string;
	sortOrder: number;
}

/**
 * Content-references repository.
 *
 * Owns relation *definitions* (`_emdash_relations`) and the *edge* junction
 * (`_emdash_content_references`, whose endpoints are content
 * `translation_group`s so edges are locale-agnostic, mirroring
 * `content_taxonomies`).
 *
 * A relation is schema, so it is not localized — it sits with
 * `_emdash_collections` and `_emdash_fields`, not with the row-per-locale
 * tables. See migration 076.
 *
 * Like `TaxonomyRepository`, this is not the validation boundary: it trusts its
 * typed inputs. The API slice supplies Zod schemas at the route and enforces
 * collection-agreement / relation-existence invariants in the handler.
 */
export class RelationRepository {
	constructor(private db: Kysely<Database>) {}

	/**
	 * Create a relation.
	 *
	 * `slug` is unique across all relations, so a duplicate raises the DB's
	 * unique violation for the handler to translate into a conflict.
	 */
	async create(input: CreateRelationInput): Promise<Relation> {
		const id = ulid();
		const now = new Date().toISOString();

		await this.db
			.insertInto("_emdash_relations")
			.values({
				id,
				slug: input.slug,
				parent_collection: input.parentCollection,
				child_collection: input.childCollection,
				parent_label: input.parentLabel,
				child_label: input.childLabel,
				parent_label_singular: input.parentLabelSingular ?? null,
				child_label_singular: input.childLabelSingular ?? null,
				max_children_per_parent: input.maxChildrenPerParent ?? null,
				max_parents_per_child: input.maxParentsPerChild ?? null,
				created_at: now,
				updated_at: now,
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
	 * Find a relation by its slug. No locale: a slug identifies a relation
	 * outright (`UNIQUE(slug)`, migration 076), which is what lets an entry in
	 * any locale address it.
	 */
	async findBySlug(slug: string): Promise<Relation | null> {
		const row = await this.db
			.selectFrom("_emdash_relations")
			.selectAll()
			.where("slug", "=", slug)
			.executeTakeFirst();
		return row ? this.rowToRelation(row) : null;
	}

	/** All relations, ordered by slug. */
	async list(): Promise<Relation[]> {
		const rows = await this.db
			.selectFrom("_emdash_relations")
			.selectAll()
			.orderBy("slug", "asc")
			.execute();
		return rows.map((row) => this.rowToRelation(row));
	}

	/** Relations where `collection` is the parent OR the child side. */
	async findForCollection(collection: string): Promise<Relation[]> {
		const rows = await this.db
			.selectFrom("_emdash_relations")
			.selectAll()
			.where((eb) =>
				eb.or([eb("parent_collection", "=", collection), eb("child_collection", "=", collection)]),
			)
			.orderBy("slug", "asc")
			.execute();
		return rows.map((row) => this.rowToRelation(row));
	}

	/**
	 * Update a relation's role labels and cardinality. Structural fields are
	 * immutable — a reference field stores the slug, and the edges are keyed by
	 * the id. No-ops when nothing is supplied.
	 */
	async update(id: string, input: UpdateRelationInput): Promise<Relation | null> {
		const existing = await this.findById(id);
		if (!existing) return null;

		const updates: Record<string, unknown> = {};
		if (input.parentLabel !== undefined) updates.parent_label = input.parentLabel;
		if (input.childLabel !== undefined) updates.child_label = input.childLabel;
		if (input.parentLabelSingular !== undefined) {
			updates.parent_label_singular = input.parentLabelSingular;
		}
		if (input.childLabelSingular !== undefined) {
			updates.child_label_singular = input.childLabelSingular;
		}
		if (input.maxChildrenPerParent !== undefined) {
			updates.max_children_per_parent = input.maxChildrenPerParent;
		}
		if (input.maxParentsPerChild !== undefined) {
			updates.max_parents_per_child = input.maxParentsPerChild;
		}

		if (Object.keys(updates).length > 0) {
			updates.updated_at = new Date().toISOString();
			await this.db.updateTable("_emdash_relations").set(updates).where("id", "=", id).execute();
		}

		return this.findById(id);
	}

	/**
	 * Delete a relation and its edges (application-layer cascade — the edge
	 * table has no FK).
	 */
	async delete(id: string): Promise<boolean> {
		const relation = await this.findById(id);
		if (!relation) return false;

		await this.db.deleteFrom("_emdash_content_references").where("relation_id", "=", id).execute();

		const result = await this.db
			.deleteFrom("_emdash_relations")
			.where("id", "=", id)
			.executeTakeFirst();
		return (result.numDeletedRows ?? 0n) > 0n;
	}

	/** Normalize a relation id OR slug to its id. Returns null for an unknown
	 * relation (edge methods then no-op, matching
	 * `TaxonomyRepository.attachToEntry`). */
	private async resolveRelationId(idOrSlug: string): Promise<string | null> {
		const row = await this.db
			.selectFrom("_emdash_relations")
			.select(["id"])
			.where((eb) => eb.or([eb("id", "=", idOrSlug), eb("slug", "=", idOrSlug)]))
			.executeTakeFirst();
		return row?.id ?? null;
	}

	private rowToReference(row: Selectable<ContentReferenceTable>): ContentReference {
		return {
			id: row.id,
			relationId: row.relation_id,
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
		const relationId = await this.resolveRelationId(relation);
		if (!relationId) return;

		let order = sortOrder;
		if (order === undefined) {
			const max = await this.db
				.selectFrom("_emdash_content_references")
				.select((eb) => eb.fn.max("sort_order").as("max"))
				.where("relation_id", "=", relationId)
				.where("parent_group", "=", parentGroup)
				.executeTakeFirst();
			order = max?.max === null || max?.max === undefined ? 0 : Number(max.max) + 1;
		}

		await this.db
			.insertInto("_emdash_content_references")
			.values({
				id: ulid(),
				relation_id: relationId,
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
		const relationId = await this.resolveRelationId(relation);
		if (!relationId) return;

		await this.db
			.deleteFrom("_emdash_content_references")
			.where("relation_id", "=", relationId)
			.where("parent_group", "=", parentGroup)
			.where("child_group", "=", childGroup)
			.execute();
	}

	/** Forward traversal: a parent's children for a relation, ordered. */
	async getChildren(relation: string, parentGroup: string): Promise<ContentReference[]> {
		const relationId = await this.resolveRelationId(relation);
		if (!relationId) return [];

		const rows = await this.db
			.selectFrom("_emdash_content_references")
			.selectAll()
			.where("relation_id", "=", relationId)
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
		const relationId = await this.resolveRelationId(relation);
		if (!relationId) return { items: [] };

		const limit = Math.min(options.limit || 50, 100);

		let query = this.db
			.selectFrom("_emdash_content_references")
			.selectAll()
			.where("relation_id", "=", relationId)
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
		const relationId = await this.resolveRelationId(relation);
		if (!relationId) return [];

		const rows = await this.db
			.selectFrom("_emdash_content_references")
			.selectAll()
			.where("relation_id", "=", relationId)
			.where("child_group", "=", childGroup)
			.orderBy("id", "asc")
			.execute();
		return rows.map((row) => this.rowToReference(row));
	}

	/**
	 * Replace all children of `parentGroup` under a relation with `childGroups`,
	 * assigning positional sort_order (index in the deduped array). Deletes the
	 * old set for this (relation, parent) and re-inserts in D1-safe batches.
	 * Mirrors the intent of `TaxonomyRepository.setTermsForEntry`.
	 *
	 * A parent references a given child at most once (the unique edge), so
	 * duplicate `childGroups` are collapsed first-occurrence-wins rather than
	 * relying on the insert's onConflict to silently drop them. Not wrapped in a
	 * transaction: an interruption after the delete can leave the parent with an
	 * empty or partial replacement. A retry restores the complete requested set.
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
		const relationId = await this.resolveRelationId(relation);
		if (!relationId) return;

		await this.db
			.deleteFrom("_emdash_content_references")
			.where("relation_id", "=", relationId)
			.where("parent_group", "=", parentGroup)
			.execute();

		// Collapse duplicates so positional sort_order has no gaps.
		const uniqueChildGroups = [...new Set(childGroups)];
		if (uniqueChildGroups.length === 0) return;

		const now = new Date().toISOString();
		const rows = uniqueChildGroups.map((childGroup, index) => ({
			id: ulid(),
			relation_id: relationId,
			parent_group: parentGroup,
			child_group: childGroup,
			sort_order: index,
			created_at: now,
		}));
		for (const rowBatch of chunks(rows, REFERENCE_INSERT_BATCH_SIZE)) {
			await this.db
				.insertInto("_emdash_content_references")
				.values(rowBatch)
				// Belt-and-suspenders: the DELETE above already cleared this
				// (relation, parent), so no conflict is possible within one call.
				// This is NOT a concurrency guarantee — delete-then-insert is not atomic.
				.onConflict((oc) => oc.doNothing())
				.execute();
		}
	}

	/**
	 * Copy every outgoing edge of `fromParentGroup` onto `toParentGroup`,
	 * preserving relation, child, and sort order. Used when duplicating a content
	 * entry so the copy carries the same reference selections (edges are
	 * storage-less, keyed by translation_group, so they don't ride along in the
	 * row's `data`). Only the parent side is copied — backlinks pointing at the
	 * original are intentionally left alone. Idempotent per edge via onConflict.
	 */
	async copyParentEdges(fromParentGroup: string, toParentGroup: string): Promise<void> {
		const rows = await this.db
			.selectFrom("_emdash_content_references")
			.selectAll()
			.where("parent_group", "=", fromParentGroup)
			.execute();
		if (rows.length === 0) return;

		const now = new Date().toISOString();
		await this.db
			.insertInto("_emdash_content_references")
			.values(
				rows.map((row) => ({
					id: ulid(),
					relation_id: row.relation_id,
					parent_group: toParentGroup,
					child_group: row.child_group,
					sort_order: row.sort_order,
					created_at: now,
				})),
			)
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
		const relationId = await this.resolveRelationId(relation);
		if (!relationId) return { items: [] };

		const limit = Math.min(options.limit || 50, 100);

		let query = this.db
			.selectFrom("_emdash_content_references")
			.selectAll()
			.where("relation_id", "=", relationId)
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
	 * Callers must be sure the whole group is gone: edges outlive any single
	 * locale row. Returns the number of edges removed.
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
		const relationId = await this.resolveRelationId(relation);
		if (!relationId) return 0;
		const result = await this.db
			.selectFrom("_emdash_content_references")
			.select((eb) => eb.fn.count("id").as("count"))
			.where("relation_id", "=", relationId)
			.where("parent_group", "=", parentGroup)
			.executeTakeFirst();
		return Number(result?.count ?? 0);
	}

	/** Count a child's parents (backlinks) under a relation. */
	async countParents(relation: string, childGroup: string): Promise<number> {
		const relationId = await this.resolveRelationId(relation);
		if (!relationId) return 0;
		const result = await this.db
			.selectFrom("_emdash_content_references")
			.select((eb) => eb.fn.count("id").as("count"))
			.where("relation_id", "=", relationId)
			.where("child_group", "=", childGroup)
			.executeTakeFirst();
		return Number(result?.count ?? 0);
	}

	/**
	 * Total edges per relation, for every relation at once. Relations with no
	 * edges are absent from the map.
	 *
	 * One grouped scan rather than a count per relation: the delete dialogs name
	 * how many links go with a relation, and the relations list shows the same
	 * number on every row.
	 */
	async countEdgesByRelation(): Promise<Map<string, number>> {
		const rows = await this.db
			.selectFrom("_emdash_content_references")
			.select(["relation_id", (eb) => eb.fn.count("id").as("count")])
			.groupBy("relation_id")
			.execute();
		return new Map(rows.map((row) => [row.relation_id, Number(row.count ?? 0)]));
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
		const relationId = await this.resolveRelationId(relation);
		if (!relationId) return counts;

		for (const chunk of chunks(parentGroups, SQL_BATCH_SIZE)) {
			const rows = await this.db
				.selectFrom("_emdash_content_references")
				.select(["parent_group", (eb) => eb.fn.count("id").as("count")])
				.where("relation_id", "=", relationId)
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
			slug: row.slug,
			parentCollection: row.parent_collection,
			childCollection: row.child_collection,
			parentLabel: row.parent_label,
			childLabel: row.child_label,
			parentLabelSingular: row.parent_label_singular,
			childLabelSingular: row.child_label_singular,
			maxChildrenPerParent: row.max_children_per_parent,
			maxParentsPerChild: row.max_parents_per_child,
		};
	}
}
