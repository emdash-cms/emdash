import { sql, type Kysely } from "kysely";
import { ulid } from "ulidx";

import { currentTimestamp } from "../dialect-helpers.js";

/**
 * Store a taxonomy's structure once instead of on every locale's definition.
 *
 * `_emdash_taxonomy_def_groups` owns `hierarchical` and `collections`, one row
 * per taxonomy `name`. `label` and `label_singular` stay on the per-locale rows
 * of `_emdash_taxonomy_defs`. Every reader resolves a definition by name and
 * terms are keyed on it, so rows of one name that sit in different translation
 * groups describe the same taxonomy: they are merged into the lowest group id.
 * Rows of different names that share a group describe different taxonomies, so
 * each name gets a group of its own: the name holding the group's anchor row
 * (`id = translation_group`) keeps the id, and the others get a fresh one.
 *
 * Rows of one name can disagree. The merged structure keeps whatever any row
 * declares, hierarchical if any row is and every collection any row attaches,
 * so no term tree flattens and no collection loses a taxonomy it showed in
 * some locale.
 *
 * The per-locale rows keep their own `hierarchical` and `collections` columns,
 * rewritten to the merged values, so code that reads them directly, such as the
 * plugin sandbox bridges, still sees the taxonomy's structure.
 *
 * Computing the merge from rows that were already rewritten gives the same
 * structure, and the last statement links rows to their group by name, so a run
 * that dies after any statement can be retried.
 */

/** Groups per `INSERT`. Each costs four bound parameters, inside D1's limit of 100. */
const GROUPS_PER_INSERT = 24;

interface DefRow {
	id: string;
	name: string;
	hierarchical: number | null;
	collections: string | null;
	translation_group: string;
}

interface MergedGroup {
	id: string;
	name: string;
	hierarchical: number;
	collections: string[];
}

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_taxonomy_def_groups")
		.ifNotExists()
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("name", "text", (col) => col.notNull())
		.addColumn("hierarchical", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("collections", "text", (col) => col.notNull().defaultTo("[]"))
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addUniqueConstraint("_emdash_taxonomy_def_groups_name_unique", ["name"])
		.execute();

	await sql`
		UPDATE _emdash_taxonomy_defs
		SET translation_group = id
		WHERE translation_group IS NULL
	`.execute(db);

	const { rows } = await sql<DefRow>`
		SELECT id, name, hierarchical, collections, translation_group
		FROM _emdash_taxonomy_defs
		ORDER BY id ASC
	`.execute(db);

	const groups = [...mergeByName(rows).values()];
	for (let start = 0; start < groups.length; start += GROUPS_PER_INSERT) {
		const batch = groups.slice(start, start + GROUPS_PER_INSERT);
		// oxlint-disable-next-line no-await-in-loop -- batches stay under D1's bound-parameter limit
		await sql`
			INSERT INTO _emdash_taxonomy_def_groups (id, name, hierarchical, collections)
			VALUES ${sql.join(
				batch.map(
					(group) =>
						sql`(${group.id}, ${group.name}, ${group.hierarchical}, ${JSON.stringify(group.collections)})`,
				),
			)}
			ON CONFLICT DO NOTHING
		`.execute(db);
	}

	await sql`
		UPDATE _emdash_taxonomy_defs
		SET
			translation_group = (
				SELECT g.id FROM _emdash_taxonomy_def_groups g
				WHERE g.name = _emdash_taxonomy_defs.name
			),
			hierarchical = (
				SELECT g.hierarchical FROM _emdash_taxonomy_def_groups g
				WHERE g.name = _emdash_taxonomy_defs.name
			),
			collections = (
				SELECT g.collections FROM _emdash_taxonomy_def_groups g
				WHERE g.name = _emdash_taxonomy_defs.name
			)
		WHERE EXISTS (
			SELECT 1 FROM _emdash_taxonomy_def_groups g
			WHERE g.name = _emdash_taxonomy_defs.name
		)
	`.execute(db);
}

/** The per-locale rows still carry the merged structure, so dropping the table loses nothing. */
export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_taxonomy_def_groups").ifExists().execute();
}

function mergeByName(rows: readonly DefRow[]): Map<string, MergedGroup> {
	const merged = new Map<string, MergedGroup>();
	for (const row of rows) {
		let group = merged.get(row.name);
		if (!group) {
			group = { id: row.translation_group, name: row.name, hierarchical: 0, collections: [] };
			merged.set(row.name, group);
		}
		if (row.translation_group < group.id) group.id = row.translation_group;
		if (row.hierarchical === 1) group.hierarchical = 1;
		for (const collection of parseCollections(row.collections)) {
			if (!group.collections.includes(collection)) group.collections.push(collection);
		}
	}
	const anchorNames = new Map(rows.map((row) => [row.id, row.name]));
	const isAnchored = (group: MergedGroup) => anchorNames.get(group.id) === group.name;
	const claimed = new Set<string>();
	for (const group of merged.values()) {
		if (isAnchored(group)) claimed.add(group.id);
	}
	for (const group of merged.values()) {
		if (isAnchored(group)) continue;
		if (claimed.has(group.id)) group.id = ulid();
		claimed.add(group.id);
	}
	return merged;
}

function parseCollections(value: string | null): string[] {
	if (!value) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((entry): entry is string => typeof entry === "string");
}
