import { sql, type Kysely, type Selectable } from "kysely";
import { ulid } from "ulidx";

import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import type { Database, RelationTable, ContentReferenceTable } from "../types.js";
import {
	decodeCursor,
	encodeCursor,
	InvalidCursorError,
	STAGED_CURSOR_MARKER,
	type FindManyResult,
} from "./types.js";

// Each reference-edge row binds six values. Derive the row count so every
// INSERT stays within D1's 100-parameter statement ceiling.
const REFERENCE_INSERT_BIND_COLUMNS = 6;
const D1_MAX_BOUND_PARAMETERS = 100;
export const REFERENCE_INSERT_BATCH_SIZE = Math.floor(
	D1_MAX_BOUND_PARAMETERS / REFERENCE_INSERT_BIND_COLUMNS,
);

// Repositioning binds an edge id twice — once to match the CASE branch, once in
// the row filter. The new position is a literal and binds nothing.
const REFERENCE_REPOSITION_BIND_COLUMNS = 2;
const REFERENCE_REPOSITION_BATCH_SIZE = Math.floor(
	D1_MAX_BOUND_PARAMETERS / REFERENCE_REPOSITION_BIND_COLUMNS,
);

/** A reference edge as it is written. */
interface EdgeInsert {
	id: string;
	relation_id: string;
	parent_group: string;
	child_group: string;
	sort_order: number;
	created_at: string;
}

/** Where an existing edge should sit in its parent's list. */
interface EdgePosition {
	id: string;
	sortOrder: number;
}

/**
 * Narrow a computed position to a non-negative integer before it is written as
 * a SQL literal. Every caller passes an array index; this is what keeps that
 * true at the one place the value stops being a bound parameter.
 */
function asPosition(sortOrder: number): number {
	if (!Number.isInteger(sortOrder) || sortOrder < 0) {
		throw new TypeError(`Invalid reference sort order: ${sortOrder}`);
	}
	return sortOrder;
}

/**
 * A relation definition. Not localized: a relation joins the same two
 * collections whatever language you read it in, and its role labels are
 * single-valued like a collection's or a field's. That is what lets `slug` be
 * unique outright (migration 086) and resolve without a locale.
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
 * tables. See migration 086.
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
	 * outright (`UNIQUE(slug)`, migration 086), which is what lets an entry in
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

	/**
	 * Insert one edge only while the end it lands on is still under its limit,
	 * deciding and writing in a single statement.
	 *
	 * A count read before the insert answers for a moment that has passed by the
	 * time the row goes in: two requests can both read a free slot and both fill
	 * it, and the unique edge constraint does not catch it because they are
	 * different pairs. Folding the count into the insert's `WHERE` makes the
	 * decision and the write one thing, on D1 as much as anywhere. Returns false
	 * when the limit refused the row.
	 */
	private async insertEdgeWithinLimit(
		row: EdgeInsert,
		limitedSide: "parent" | "child",
		limit: number,
	): Promise<boolean> {
		const column = limitedSide === "parent" ? "parent_group" : "child_group";
		const group = limitedSide === "parent" ? row.parent_group : row.child_group;
		const result = await sql`
			INSERT INTO ${sql.ref("_emdash_content_references")}
				(id, relation_id, parent_group, child_group, sort_order, created_at)
			SELECT ${row.id}, ${row.relation_id}, ${row.parent_group}, ${row.child_group},
			       ${row.sort_order}, ${row.created_at}
			WHERE (
				SELECT COUNT(*) FROM ${sql.ref("_emdash_content_references")}
				WHERE relation_id = ${row.relation_id} AND ${sql.ref(column)} = ${group}
			) < ${limit}
		`.execute(this.db);
		return (result.numAffectedRows ?? 0n) > 0n;
	}

	/**
	 * Write new edges, taking back the ones already written if the limited end
	 * refuses a later one.
	 *
	 * Returns the refused group in a one-element array, or an empty array when
	 * every row went in. The rollback is what lets a replacement add before it
	 * removes: on D1 nothing else can take a partial write back.
	 *
	 * An unlimited end cannot refuse anything, so its rows go in as batches; a
	 * limited one takes a statement per edge, because a limit enforced only by a
	 * count before the write is one two requests can both walk past.
	 */
	private async insertEdges(
		rows: EdgeInsert[],
		limitedSide: "parent" | "child",
		limit: number | null,
	): Promise<string[]> {
		if (rows.length === 0) return [];

		if (limit === null) {
			for (const rowBatch of chunks(rows, REFERENCE_INSERT_BATCH_SIZE)) {
				// oxlint-disable-next-line no-await-in-loop -- one statement per D1-safe batch
				await this.db
					.insertInto("_emdash_content_references")
					.values(rowBatch)
					.onConflict((oc) => oc.doNothing())
					.execute();
			}
			return [];
		}

		const written: string[] = [];
		for (const row of rows) {
			// oxlint-disable-next-line no-await-in-loop -- one statement per edge is what makes the limit hold
			const inserted = await this.insertEdgeWithinLimit(row, limitedSide, limit);
			if (inserted) {
				written.push(row.id);
				continue;
			}
			await this.deleteEdgesById(written);
			return [limitedSide === "parent" ? row.parent_group : row.child_group];
		}
		return [];
	}

	/** Remove edges by id, in D1-safe batches. */
	private async deleteEdgesById(ids: string[]): Promise<void> {
		for (const idBatch of chunks(ids, SQL_BATCH_SIZE)) {
			// oxlint-disable-next-line no-await-in-loop -- one statement per bind-parameter batch
			await this.db.deleteFrom("_emdash_content_references").where("id", "in", idBatch).execute();
		}
	}

	/**
	 * Move kept edges to their new positions, a statement per batch rather than
	 * one per edge: dragging one entry up a long list moves every entry below it,
	 * and that is a single editor action.
	 */
	private async repositionEdges(moves: EdgePosition[]): Promise<void> {
		for (const moveBatch of chunks(moves, REFERENCE_REPOSITION_BATCH_SIZE)) {
			// The position is a literal, not a bind: it is an index this method
			// computed, and every branch of a CASE binding one would leave Postgres
			// inferring the result type from parameters alone.
			const branches = moveBatch.map(
				(move) => sql`WHEN ${move.id} THEN ${sql.lit(asPosition(move.sortOrder))}`,
			);
			// oxlint-disable-next-line no-await-in-loop -- one statement per bind-parameter batch
			await this.db
				.updateTable("_emdash_content_references")
				.set({
					sort_order: sql<number>`CASE ${sql.ref("id")} ${sql.join(branches, sql` `)} END`,
				})
				.where(
					"id",
					"in",
					moveBatch.map((move) => move.id),
				)
				.execute();
		}
	}

	/** Normalize a relation id OR slug to its id. Returns null for an unknown
	 * relation (edge methods then no-op, matching
	 * `TaxonomyRepository.attachToEntry`). */
	private async resolveRelationId(idOrSlug: string): Promise<string | null> {
		return (await this.resolveRelationLimits(idOrSlug))?.id ?? null;
	}

	/** The same lookup, carrying the limits an edge write has to hold to. */
	private async resolveRelationLimits(idOrSlug: string): Promise<{
		id: string;
		maxChildrenPerParent: number | null;
		maxParentsPerChild: number | null;
	} | null> {
		const row = await this.db
			.selectFrom("_emdash_relations")
			.select(["id", "max_children_per_parent", "max_parents_per_child"])
			.where((eb) => eb.or([eb("id", "=", idOrSlug), eb("slug", "=", idOrSlug)]))
			.executeTakeFirst();
		if (!row) return null;
		return {
			id: row.id,
			maxChildrenPerParent: row.max_children_per_parent,
			maxParentsPerChild: row.max_parents_per_child,
		};
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
		return this.getChildrenPageById(relationId, parentGroup, options);
	}

	/** `getChildrenPage` for a caller that already holds the relation's id. */
	async getChildrenPageById(
		relationId: string,
		parentGroup: string,
		options: { limit?: number; cursor?: string } = {},
	): Promise<FindManyResult<ContentReference>> {
		const limit = Math.min(options.limit || 50, 100);

		let query = this.db
			.selectFrom("_emdash_content_references")
			.selectAll()
			.where("relation_id", "=", relationId)
			.where("parent_group", "=", parentGroup);

		if (options.cursor) {
			const decoded = decodeCursor(options.cursor);
			if (decoded.orderValue === STAGED_CURSOR_MARKER) {
				// A cursor issued over a draft's pending selection anchors on a
				// translation group rather than a row here, which is what a render
				// sees when the draft publishes mid-pagination. Resume after that
				// group's edge so the walk continues; if the group is no longer
				// selected there is nothing to resume from, so the page restarts.
				query = query.where((eb) => {
					const anchor = () =>
						eb
							.selectFrom("_emdash_content_references as anchor")
							.where("anchor.relation_id", "=", relationId)
							.where("anchor.parent_group", "=", parentGroup)
							.where("anchor.child_group", "=", decoded.id);
					return eb.or([
						eb.not(eb.exists(anchor().select("anchor.id"))),
						eb("sort_order", ">", anchor().select("anchor.sort_order")),
						eb.and([
							eb("sort_order", "=", anchor().select("anchor.sort_order")),
							eb("id", ">", anchor().select("anchor.id")),
						]),
					]);
				});
			} else {
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
	 * assigning positional sort_order (index in the deduped array).
	 * Mirrors the intent of `TaxonomyRepository.setTermsForEntry`.
	 *
	 * A parent references a given child at most once (the unique edge), so
	 * duplicate `childGroups` are collapsed first-occurrence-wins rather than
	 * relying on the insert's onConflict to silently drop them.
	 *
	 * Written as a diff, in the order add → remove → reposition, rather than as a
	 * delete of the whole end followed by a re-insert. There is no transaction on
	 * D1: a replacement that removed first would leave the parent holding nothing
	 * the moment the far side refused one of the additions, and report a failed
	 * save over an emptied field. Additions already written come back out when a
	 * later one is refused, so a refused call leaves the selection as it found it.
	 * The diff also keeps an edge the caller is merely re-stating out of the far
	 * side's count, which a delete-and-reinsert survives only because its delete
	 * frees the slot a moment before it asks for it back.
	 *
	 * Concurrency: two simultaneous replace-all calls for the same (relation,
	 * parent) can interleave and merge into the union of both sets (a lost update
	 * — neither "replace" wins). This is non-corrupting — keyset pagination stays
	 * totally ordered via the `(sort_order, id)` tiebreak even with duplicate
	 * sort_orders — and a single client editing one parent's children serially
	 * never hits it. A D1-portable fix isn't available (no multi-statement
	 * transactions), so concurrent replace-all on one parent is unsupported by
	 * design rather than guarded here.
	 *
	 * Returns the child group `maxParentsPerChild` refused, in a one-element
	 * array — empty unless the relation limits that end and something else has
	 * taken the slot since the caller resolved its selection.
	 */
	async setChildren(
		relation: string,
		parentGroup: string,
		childGroups: string[],
	): Promise<string[]> {
		const rel = await this.resolveRelationLimits(relation);
		if (!rel) return [];

		const existing = await this.db
			.selectFrom("_emdash_content_references")
			.select(["id", "child_group", "sort_order"])
			.where("relation_id", "=", rel.id)
			.where("parent_group", "=", parentGroup)
			.execute();
		const existingChildren = new Set(existing.map((row) => row.child_group));

		// Collapse duplicates so positional sort_order has no gaps.
		const uniqueChildGroups = [...new Set(childGroups)];
		const positions = new Map(uniqueChildGroups.map((childGroup, index) => [childGroup, index]));

		const now = new Date().toISOString();
		const additions = uniqueChildGroups
			.map((childGroup, index) => ({ childGroup, index }))
			.filter(({ childGroup }) => !existingChildren.has(childGroup))
			.map(({ childGroup, index }) => ({
				id: ulid(),
				relation_id: rel.id,
				parent_group: parentGroup,
				child_group: childGroup,
				sort_order: index,
				created_at: now,
			}));

		const rejected = await this.insertEdges(additions, "child", rel.maxParentsPerChild);
		if (rejected.length > 0) return rejected;

		const removals: string[] = [];
		const repositions: EdgePosition[] = [];
		for (const row of existing) {
			const position = positions.get(row.child_group);
			if (position === undefined) removals.push(row.id);
			else if (position !== row.sort_order) repositions.push({ id: row.id, sortOrder: position });
		}
		await this.deleteEdgesById(removals);
		await this.repositionEdges(repositions);
		return [];
	}

	/**
	 * Replace all parents of `childGroup` under a relation with `parentGroups`:
	 * the mirror of `setChildren`, for a field bound to the child side.
	 *
	 * Duplicates collapse first-occurrence-wins, and the same diff ordering and
	 * non-transactional caveats apply — see `setChildren`, including that two
	 * concurrent replace-all calls for one (relation, child) can merge.
	 *
	 * `sort_order` orders children within a parent and has no counterpart on this
	 * side, so a *new* edge takes the next position among that parent's existing
	 * children rather than a position in this child's list. A parent the caller
	 * re-states keeps the position it already holds: that position is the other
	 * side's list order, and saving a backlink field must not rewrite it. A
	 * child-side field therefore has no order of its own; `getParents` reads by
	 * `id`.
	 *
	 * Returns the parent group `maxChildrenPerParent` refused, the mirror of what
	 * `setChildren` returns.
	 */
	async setParents(
		relation: string,
		childGroup: string,
		parentGroups: string[],
	): Promise<string[]> {
		const rel = await this.resolveRelationLimits(relation);
		if (!rel) return [];
		const relationId = rel.id;

		const existing = await this.db
			.selectFrom("_emdash_content_references")
			.select(["id", "parent_group"])
			.where("relation_id", "=", relationId)
			.where("child_group", "=", childGroup)
			.execute();
		const existingParents = new Set(existing.map((row) => row.parent_group));

		const uniqueParentGroups = [...new Set(parentGroups)];
		const selected = new Set(uniqueParentGroups);
		const newParents = uniqueParentGroups.filter(
			(parentGroup) => !existingParents.has(parentGroup),
		);

		// One query for every new parent's highest position, so appending stays a
		// fixed number of round trips rather than one per parent.
		const nextSortOrder = new Map<string, number>();
		for (const groupBatch of chunks(newParents, REFERENCE_INSERT_BATCH_SIZE)) {
			// oxlint-disable-next-line no-await-in-loop -- one statement per bind-parameter batch
			const maxima = await this.db
				.selectFrom("_emdash_content_references")
				.select((eb) => ["parent_group", eb.fn.max("sort_order").as("max")])
				.where("relation_id", "=", relationId)
				.where("parent_group", "in", groupBatch)
				.groupBy("parent_group")
				.execute();
			for (const row of maxima) {
				nextSortOrder.set(row.parent_group, row.max === null ? 0 : Number(row.max) + 1);
			}
		}

		const now = new Date().toISOString();
		const additions = newParents.map((parentGroup) => ({
			id: ulid(),
			relation_id: relationId,
			parent_group: parentGroup,
			child_group: childGroup,
			sort_order: nextSortOrder.get(parentGroup) ?? 0,
			created_at: now,
		}));

		const rejected = await this.insertEdges(additions, "parent", rel.maxChildrenPerParent);
		if (rejected.length > 0) return rejected;

		await this.deleteEdgesById(
			existing.filter((row) => !selected.has(row.parent_group)).map((row) => row.id),
		);
		return [];
	}

	/**
	 * Copy every outgoing edge of `fromParentGroup` onto `toParentGroup`,
	 * preserving relation, child, and sort order. Used when duplicating a content
	 * entry so the copy carries the same reference selections (edges are
	 * storage-less, keyed by translation_group, so they don't ride along in the
	 * row's `data`). Only the parent side is copied; backlinks pointing at the
	 * original stay on the original. Idempotent per edge via onConflict.
	 *
	 * A copy is still a new edge, so it holds to `maxParentsPerChild` like any
	 * other: a child already at its limit cannot also belong to the copy. Returns
	 * the child group that refused, in a one-element array, having taken back
	 * every edge this call had already written — the caller decides what a
	 * duplicate that cannot carry its selection should do.
	 */
	async copyParentEdges(fromParentGroup: string, toParentGroup: string): Promise<string[]> {
		const rows = await this.db
			.selectFrom("_emdash_content_references")
			.selectAll()
			.where("parent_group", "=", fromParentGroup)
			.execute();
		if (rows.length === 0) return [];

		const now = new Date().toISOString();
		// Each relation carries its own limit, so the copies are written a relation
		// at a time rather than as one undifferentiated batch.
		const byRelation = new Map<string, EdgeInsert[]>();
		for (const row of rows) {
			const copies = byRelation.get(row.relation_id) ?? [];
			copies.push({
				id: ulid(),
				relation_id: row.relation_id,
				parent_group: toParentGroup,
				child_group: row.child_group,
				sort_order: row.sort_order,
				created_at: now,
			});
			byRelation.set(row.relation_id, copies);
		}

		const written: string[] = [];
		for (const [relationId, copies] of byRelation) {
			// oxlint-disable-next-line no-await-in-loop -- each relation's limit gates its own copies
			const rel = await this.resolveRelationLimits(relationId);
			// oxlint-disable-next-line no-await-in-loop -- sequential so a refusal stops the rest
			const rejected = await this.insertEdges(copies, "child", rel?.maxParentsPerChild ?? null);
			if (rejected.length > 0) {
				// `insertEdges` took back its own partial write; the relations already
				// copied are this call's to undo.
				await this.deleteEdgesById(written);
				return rejected;
			}
			written.push(...copies.map((copy) => copy.id));
		}
		return [];
	}

	/**
	 * How many edges each of `groups` already holds at one end of a relation,
	 * ignoring edges whose opposite end is `excludeOppositeGroup`.
	 *
	 * The exclusion is what lets a re-save of an unchanged selection pass: the
	 * selecting entry's own edges are not counted against the limit it is about
	 * to re-establish. Groups with no edges are absent from the map.
	 */
	async countEdgesByGroup(
		relationId: string,
		side: "parent" | "child",
		groups: string[],
		excludeOppositeGroup: string | null,
	): Promise<Map<string, number>> {
		const column = side === "parent" ? "parent_group" : "child_group";
		const opposite = side === "parent" ? "child_group" : "parent_group";

		const counts = new Map<string, number>();
		for (const groupBatch of chunks([...new Set(groups)], SQL_BATCH_SIZE)) {
			let query = this.db
				.selectFrom("_emdash_content_references")
				.select((eb) => [column, eb.fn.countAll().as("count")])
				.where("relation_id", "=", relationId)
				.where(column, "in", groupBatch);
			// An entry with no group of its own yet holds no links to discount, and
			// `!= NULL` is never true — it would silently count nothing at all.
			if (excludeOppositeGroup !== null) {
				query = query.where(opposite, "!=", excludeOppositeGroup);
			}
			// oxlint-disable-next-line no-await-in-loop -- one statement per bind-parameter batch
			const rows = await query.groupBy(column).execute();
			for (const row of rows) {
				counts.set(row[column], Number(row.count));
			}
		}
		return counts;
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
		return this.getParentsPageById(relationId, childGroup, options);
	}

	/** `getParentsPage` for a caller that already holds the relation's id. */
	async getParentsPageById(
		relationId: string,
		childGroup: string,
		options: { limit?: number; cursor?: string } = {},
	): Promise<FindManyResult<ContentReference>> {
		const limit = Math.min(options.limit || 50, 100);

		let query = this.db
			.selectFrom("_emdash_content_references")
			.selectAll()
			.where("relation_id", "=", relationId)
			.where("child_group", "=", childGroup);

		if (options.cursor) {
			const decoded = decodeCursor(options.cursor);
			if (decoded.orderValue === STAGED_CURSOR_MARKER) {
				// The mirror of `getChildrenPageById`: a staged cursor anchors on a
				// translation group, which compared against `id` would page from an
				// arbitrary point. Resume after that group's edge, or restart when the
				// group is no longer selected.
				query = query.where((eb) => {
					const anchor = eb
						.selectFrom("_emdash_content_references as anchor")
						.where("anchor.relation_id", "=", relationId)
						.where("anchor.child_group", "=", childGroup)
						.where("anchor.parent_group", "=", decoded.id);
					return eb.or([
						eb.not(eb.exists(anchor.select("anchor.id"))),
						eb("id", ">", anchor.select("anchor.id")),
					]);
				});
			} else {
				query = query.where("id", ">", decoded.id);
			}
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
