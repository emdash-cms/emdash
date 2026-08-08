import { sql, type Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

/**
 * Add `taxonomies.sort_order` and mint a position for every existing term.
 *
 * Terms carry an explicit order rather than falling back to alphabetical, so
 * existing rows need real positions rather than a uniform default. Groups are
 * numbered by `(label, id)` — the order term listings used before this
 * migration — so the rendered order is unchanged the moment it runs. What
 * changes is what happens next: a term created afterwards appends to the end of
 * its group instead of slotting in alphabetically.
 *
 * A position belongs to a `translation_group`, not a row, so every row of a
 * group gets the same value and sibling groups are keyed on the raw `parent_id`
 * column (itself a translation_group). Numbering reads the table once and
 * computes in JS: SQLite and Postgres would each need their own window-function
 * spelling, and `taxonomies` is small enough that it isn't worth two dialects
 * of SQL.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "taxonomies", "sort_order")) return;

	await db.schema
		.alterTable("taxonomies")
		.addColumn("sort_order", "integer", (col) => col.notNull().defaultTo(0))
		.execute();

	const { rows } = await sql<{
		id: string;
		name: string;
		label: string | null;
		parent_id: string | null;
		translation_group: string | null;
	}>`SELECT id, name, label, parent_id, translation_group FROM taxonomies`.execute(db);

	// One entry per translation_group: a group holds a single position, and its
	// rows can disagree on label and parent across locales, so the lowest row id
	// decides for the whole group and the mint stays deterministic however the
	// rows come back. Taxonomy names are `[a-z][a-z0-9_]*` and parents are
	// ULIDs, so "/" can't appear in either half of the sibling key.
	const groups = new Map<string, { sibling: string; label: string; id: string }>();
	for (const row of rows) {
		const group = row.translation_group ?? row.id;
		const chosen = groups.get(group);
		if (chosen && chosen.id <= row.id) continue;
		groups.set(group, {
			sibling: row.name + "/" + (row.parent_id ?? ""),
			label: row.label ?? "",
			id: row.id,
		});
	}

	const siblings = new Map<string, { group: string; label: string; id: string }[]>();
	for (const [group, { sibling, label, id }] of groups) {
		let members = siblings.get(sibling);
		if (!members) siblings.set(sibling, (members = []));
		members.push({ group, label, id });
	}

	for (const members of siblings.values()) {
		members.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
		for (const [position, member] of members.entries()) {
			if (position === 0) continue; // The column default already covers it.
			await sql`
				UPDATE taxonomies SET sort_order = ${position}
				WHERE translation_group = ${member.group}
					OR (translation_group IS NULL AND id = ${member.group})
			`.execute(db);
		}
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "taxonomies", "sort_order")) {
		await db.schema.alterTable("taxonomies").dropColumn("sort_order").execute();
	}
}
