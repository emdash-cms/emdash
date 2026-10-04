import { sql, type Kysely } from "kysely";

import type { Database } from "../types.js";

/**
 * A taxonomy's structure: the same in every locale. Stored once in
 * `_emdash_taxonomy_def_groups`, keyed by name, and copied onto each locale's
 * `_emdash_taxonomy_defs` row for code that reads it directly, such as the plugin
 * sandbox bridges.
 */
export interface TaxonomyStructure {
	hierarchical: boolean;
	collections: string[];
}

/**
 * Select definition rows (aliased `d`) with their taxonomy's structure.
 * Qualify columns in `where` and `orderBy`: `id` and `name` exist on both tables.
 *
 * A row that has no group yet, because code without the group table wrote it
 * during a rolling deploy, reads its own copy.
 */
export function selectTaxonomyDefs(db: Kysely<Database>) {
	return db
		.selectFrom("_emdash_taxonomy_defs as d")
		.leftJoin("_emdash_taxonomy_def_groups as g", "g.name", "d.name")
		.select([
			"d.id",
			"d.name",
			"d.label",
			"d.label_singular",
			"d.created_at",
			"d.locale",
			"d.translation_group",
			sql<number>`coalesce(g.hierarchical, d.hierarchical)`.as("hierarchical"),
			sql<string | null>`coalesce(g.collections, d.collections)`.as("collections"),
		]);
}

/**
 * The taxonomy's group id and structure, or null when no locale defines `name`.
 * A group whose definitions are all gone counts as deleted.
 */
export async function findTaxonomyStructure(
	db: Kysely<Database>,
	name: string,
): Promise<(TaxonomyStructure & { id: string }) | null> {
	const row = await selectTaxonomyDefs(db)
		.where("d.name", "=", name)
		.orderBy("d.id", "asc")
		.executeTakeFirst();
	if (!row) return null;
	return {
		id: row.translation_group ?? row.id,
		hierarchical: row.hierarchical === 1,
		collections: parseTaxonomyCollections(row.collections),
	};
}

/**
 * Write a taxonomy's structure for every locale and return its group id.
 *
 * Creates the group with `groupId` and `structure` when the name has none. An
 * existing group changes only the fields in `overwrite`, so a caller holding an
 * older read of the other field does not write it back. Every definition row of
 * the name is then linked to the group and copies its values, including rows
 * written without it.
 */
export async function saveTaxonomyStructure(
	db: Kysely<Database>,
	name: string,
	groupId: string,
	structure: TaxonomyStructure,
	overwrite: Partial<TaxonomyStructure> = structure,
): Promise<string> {
	const changes: { hierarchical?: number; collections?: string } = {};
	if (overwrite.hierarchical !== undefined) changes.hierarchical = overwrite.hierarchical ? 1 : 0;
	if (overwrite.collections !== undefined) {
		changes.collections = JSON.stringify([...new Set(overwrite.collections)]);
	}
	const saved = await db
		.insertInto("_emdash_taxonomy_def_groups")
		.values({
			id: groupId,
			name,
			hierarchical: structure.hierarchical ? 1 : 0,
			collections: JSON.stringify([...new Set(structure.collections)]),
		})
		.onConflict((oc) =>
			Object.keys(changes).length > 0
				? oc.column("name").doUpdateSet(changes)
				: oc.column("name").doNothing(),
		)
		.returning(["id", "hierarchical", "collections"])
		.executeTakeFirst();
	const group =
		saved ??
		(await db
			.selectFrom("_emdash_taxonomy_def_groups")
			.select(["id", "hierarchical", "collections"])
			.where("name", "=", name)
			.executeTakeFirstOrThrow());
	await db
		.updateTable("_emdash_taxonomy_defs")
		.set({
			hierarchical: group.hierarchical,
			collections: group.collections,
			translation_group: group.id,
		})
		.where("name", "=", name)
		.execute();
	return group.id;
}

/** Parse a stored `collections` value, skipping anything that isn't a string list. */
export function parseTaxonomyCollections(value: string | null): string[] {
	if (!value) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return [...new Set(parsed.filter((entry): entry is string => typeof entry === "string"))];
}
