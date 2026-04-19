import { sql } from "kysely";
import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import type { Database, TaxonomyTable, ContentTaxonomyTable } from "../types.js";
import { validateIdentifier } from "../validate.js";

export interface Taxonomy {
	id: string;
	name: string;
	slug: string;
	label: string;
	parentId: string | null;
	data: Record<string, unknown> | null;
}

export interface CreateTaxonomyInput {
	name: string;
	slug: string;
	label: string;
	parentId?: string;
	data?: Record<string, unknown>;
}

export interface UpdateTaxonomyInput {
	slug?: string;
	label?: string;
	parentId?: string | null;
	data?: Record<string, unknown>;
}

/**
 * Taxonomy repository for categories, tags, and other classification
 *
 * Taxonomies are hierarchical (via parentId) and can be attached to content entries.
 */
export class TaxonomyRepository {
	constructor(private db: Kysely<Database>) {}

	/**
	 * Create a new taxonomy term
	 */
	async create(input: CreateTaxonomyInput): Promise<Taxonomy> {
		const id = ulid();

		const row: TaxonomyTable = {
			id,
			name: input.name,
			slug: input.slug,
			label: input.label,
			parent_id: input.parentId ?? null,
			data: input.data ? JSON.stringify(input.data) : null,
		};

		await this.db.insertInto("taxonomies").values(row).execute();

		const taxonomy = await this.findById(id);
		if (!taxonomy) {
			throw new Error("Failed to create taxonomy");
		}
		return taxonomy;
	}

	/**
	 * Find taxonomy by ID
	 */
	async findById(id: string): Promise<Taxonomy | null> {
		const row = await this.db
			.selectFrom("taxonomies")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();

		return row ? this.rowToTaxonomy(row) : null;
	}

	/**
	 * Find taxonomy by name and slug (unique constraint)
	 */
	async findBySlug(name: string, slug: string): Promise<Taxonomy | null> {
		const row = await this.db
			.selectFrom("taxonomies")
			.selectAll()
			.where("name", "=", name)
			.where("slug", "=", slug)
			.executeTakeFirst();

		return row ? this.rowToTaxonomy(row) : null;
	}

	/**
	 * Get all terms for a taxonomy (e.g., all categories)
	 */
	async findByName(name: string, options: { parentId?: string | null } = {}): Promise<Taxonomy[]> {
		let query = this.db
			.selectFrom("taxonomies")
			.selectAll()
			.where("name", "=", name)
			.orderBy("label", "asc");

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

	/**
	 * Get children of a taxonomy term
	 */
	async findChildren(parentId: string): Promise<Taxonomy[]> {
		const rows = await this.db
			.selectFrom("taxonomies")
			.selectAll()
			.where("parent_id", "=", parentId)
			.orderBy("label", "asc")
			.execute();

		return rows.map((row) => this.rowToTaxonomy(row));
	}

	/**
	 * Update a taxonomy term
	 */
	async update(id: string, input: UpdateTaxonomyInput): Promise<Taxonomy | null> {
		const existing = await this.findById(id);
		if (!existing) return null;

		const updates: Partial<TaxonomyTable> = {};
		if (input.slug !== undefined) updates.slug = input.slug;
		if (input.label !== undefined) updates.label = input.label;
		if (input.parentId !== undefined) updates.parent_id = input.parentId;
		if (input.data !== undefined) updates.data = JSON.stringify(input.data);

		if (Object.keys(updates).length > 0) {
			await this.db.updateTable("taxonomies").set(updates).where("id", "=", id).execute();
		}

		return this.findById(id);
	}

	/**
	 * Delete a taxonomy term
	 */
	async delete(id: string): Promise<boolean> {
		// First remove any content associations
		await this.db.deleteFrom("content_taxonomies").where("taxonomy_id", "=", id).execute();

		const result = await this.db.deleteFrom("taxonomies").where("id", "=", id).executeTakeFirst();

		return (result.numDeletedRows ?? 0) > 0;
	}

	// --- Content-Taxonomy Junction ---

	/**
	 * Attach a taxonomy term to a content entry
	 */
	async attachToEntry(collection: string, entryId: string, taxonomyId: string): Promise<void> {
		const row: ContentTaxonomyTable = {
			collection,
			entry_id: entryId,
			taxonomy_id: taxonomyId,
		};

		// Use INSERT OR IGNORE pattern for idempotency
		await this.db
			.insertInto("content_taxonomies")
			.values(row)
			.onConflict((oc) => oc.doNothing())
			.execute();
	}

	/**
	 * Detach a taxonomy term from a content entry
	 */
	async detachFromEntry(collection: string, entryId: string, taxonomyId: string): Promise<void> {
		await this.db
			.deleteFrom("content_taxonomies")
			.where("collection", "=", collection)
			.where("entry_id", "=", entryId)
			.where("taxonomy_id", "=", taxonomyId)
			.execute();
	}

	/**
	 * Get all taxonomy terms for a content entry
	 */
	async getTermsForEntry(
		collection: string,
		entryId: string,
		taxonomyName?: string,
	): Promise<Taxonomy[]> {
		let query = this.db
			.selectFrom("content_taxonomies")
			.innerJoin("taxonomies", "taxonomies.id", "content_taxonomies.taxonomy_id")
			.selectAll("taxonomies")
			.where("content_taxonomies.collection", "=", collection)
			.where("content_taxonomies.entry_id", "=", entryId);

		if (taxonomyName) {
			query = query.where("taxonomies.name", "=", taxonomyName);
		}

		const rows = await query.execute();
		return rows.map((row) => this.rowToTaxonomy(row));
	}

	/**
	 * Set all taxonomy terms for a content entry (replaces existing)
	 * Uses batch operations to avoid N+1 queries.
	 */
	async setTermsForEntry(
		collection: string,
		entryId: string,
		taxonomyName: string,
		taxonomyIds: string[],
	): Promise<void> {
		// Get current terms of this taxonomy type
		const current = await this.getTermsForEntry(collection, entryId, taxonomyName);
		const currentIds = new Set(current.map((t) => t.id));
		const newIds = new Set(taxonomyIds);

		// Batch remove terms no longer present
		const toRemove = current.filter((t) => !newIds.has(t.id)).map((t) => t.id);
		if (toRemove.length > 0) {
			await this.db
				.deleteFrom("content_taxonomies")
				.where("collection", "=", collection)
				.where("entry_id", "=", entryId)
				.where("taxonomy_id", "in", toRemove)
				.execute();
		}

		// Batch add new terms
		const toAdd = taxonomyIds.filter((id) => !currentIds.has(id));
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

	/**
	 * Remove all taxonomy associations for an entry (use when entry is deleted)
	 */
	async clearEntryTerms(collection: string, entryId: string): Promise<number> {
		const result = await this.db
			.deleteFrom("content_taxonomies")
			.where("collection", "=", collection)
			.where("entry_id", "=", entryId)
			.executeTakeFirst();

		return Number(result.numDeletedRows ?? 0);
	}

	/**
	 * Count entries that have a specific taxonomy term.
	 * By default, only counts published entries. Pass 'all' to count
	 * entries regardless of status, or a specific status like 'draft' or 'scheduled'.
	 */
	async countEntriesWithTerm(taxonomyId: string, status?: string): Promise<number> {
		const effectiveStatus = status ?? "published";

		if (effectiveStatus === "all") {
			const result = await this.db
				.selectFrom("content_taxonomies")
				.select((eb) => eb.fn.count("entry_id").as("count"))
				.where("taxonomy_id", "=", taxonomyId)
				.executeTakeFirst();

			return Number(result?.count || 0);
		}

		// For status filtering, we need raw SQL to join dynamic ec_* tables.
		// Get distinct collections for this taxonomy term first.
		const collections = await this.db
			.selectFrom("content_taxonomies")
			.select("collection")
			.distinct()
			.where("taxonomy_id", "=", taxonomyId)
			.execute();

		if (collections.length === 0) return 0;

		// Count entries matching status by joining each collection's content table
		let totalCount = 0;
		for (const { collection } of collections) {
			const tableName = `ec_${collection}`;
			validateIdentifier(tableName, "content table");
			const result = await sql<{ count: number }>`
				SELECT COUNT(ct.entry_id) AS count
				FROM content_taxonomies ct
				INNER JOIN ${sql.ref(tableName)} ON ct.entry_id = ${sql.ref(tableName)}.id
				WHERE ct.taxonomy_id = ${taxonomyId}
				AND ${sql.ref(tableName)}.status = ${effectiveStatus}
			`.execute(this.db);

			totalCount += Number(result.rows[0]?.count || 0);
		}

		return totalCount;
	}

	/**
	 * Convert database row to Taxonomy object
	 */
	private rowToTaxonomy(row: TaxonomyTable): Taxonomy {
		return {
			id: row.id,
			name: row.name,
			slug: row.slug,
			label: row.label,
			parentId: row.parent_id,
			data: row.data ? JSON.parse(row.data) : null,
		};
	}
}
