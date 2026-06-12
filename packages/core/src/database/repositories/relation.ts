import type { Kysely, Selectable } from "kysely";
import { ulid } from "ulidx";

import type { Database, RelationTable } from "../types.js";

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
		let query = this.db
			.selectFrom("_emdash_relations")
			.selectAll()
			.where("name", "=", name);
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
				eb.or([
					eb("parent_collection", "=", collection),
					eb("child_collection", "=", collection),
				]),
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
			await this.db
				.updateTable("_emdash_relations")
				.set(updates)
				.where("id", "=", id)
				.execute();
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
