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
	 * `translationOf`, joins the source's group and inherits its structural
	 * fields (name + both collections); only locale + labels vary per locale.
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
