import type { Kysely } from "kysely";
import { sql } from "kysely";
import { ulid } from "ulidx";

import { chunks, SQL_BATCH_SIZE } from "../utils/chunks.js";
import { currentTimestampValue, tableExists } from "./dialect-helpers.js";
import { REFERENCE_INSERT_BATCH_SIZE } from "./repositories/relation.js";
import { validateIdentifier } from "./validate.js";

/** What to copy, and which relation to copy it into. */
export interface ReferenceBackfill {
	/** Collection owning the field, the relation's parent end. */
	parentCollection: string;
	/** The relation's child end, where the column's ids resolve. */
	childCollection: string;
	fieldSlug: string;
	relationId: string;
	/** The relation's limit for this side. `null` is unlimited. */
	maxChildren: number | null;
}

/** The ids one column value holds. */
function parseColumnIds(value: unknown): string[] {
	if (typeof value !== "string" || value.length === 0) return [];
	if (!value.startsWith("[")) return [value];
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return [value];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/**
 * Copy a reference field's column values in as relation edges.
 *
 * A reference field created before relations existed holds its selection in a
 * TEXT column: one entry id, or a JSON array of them for a multiple-reference
 * field (`serializeValue` stringifies the array). Binding the field to a relation
 * moves that selection into `_emdash_content_references`, and this is the copy.
 *
 * The column is not touched. On a site that predates pickers it was a free-text
 * box, so it can hold anything an editor typed, and only the ids that resolve to
 * an entry become edges — clearing it would destroy the rest. Nothing writes to
 * it once the field is bound and typegen stops declaring the key, but a content
 * read still reports the frozen value in `data` beside the live `references`.
 *
 * Both ends of an edge are translation groups, so the locale siblings of one
 * entry contribute to the same parent group. They are read in a fixed order and
 * their ids deduped, and the result is capped at the relation's limit — a
 * single-reference field whose locale rows point at different entries keeps the
 * first rather than storing a selection the relation forbids.
 *
 * Every insert is `ON CONFLICT DO NOTHING` against the edge table's unique
 * constraint, so running this twice adds nothing the first run already wrote.
 *
 * Migration 077 carries its own copy of this for the upgrade path. A migration
 * must not share a module with the handler layer — the bundler then puts the two
 * in chunks that cycle through the migration runner, and the built package throws
 * on import — and a shipped migration has to keep behaving the way it did anyway.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- runs against a migration's untyped Kysely as well as the app's
export async function backfillReferenceEdges(
	db: Kysely<any>,
	backfill: ReferenceBackfill,
): Promise<void> {
	const parentTable = `ec_${backfill.parentCollection}`;
	const childTable = `ec_${backfill.childCollection}`;
	validateIdentifier(parentTable, "content table name");
	validateIdentifier(childTable, "content table name");
	validateIdentifier(backfill.fieldSlug, "content field name");

	if (!(await tableExists(db, parentTable)) || !(await tableExists(db, childTable))) return;

	const entries = await sql<{ translation_group: string | null; value: unknown }>`
		SELECT translation_group, ${sql.ref(backfill.fieldSlug)} AS value
		FROM ${sql.ref(parentTable)}
		WHERE ${sql.ref(backfill.fieldSlug)} IS NOT NULL
		ORDER BY locale, id
	`.execute(db);

	// Parent group -> the child entry ids it selects, in order, deduped.
	const selections = new Map<string, string[]>();
	for (const entry of entries.rows) {
		if (!entry.translation_group) continue;
		const existing = selections.get(entry.translation_group) ?? [];
		for (const id of parseColumnIds(entry.value)) {
			if (!existing.includes(id)) existing.push(id);
		}
		selections.set(entry.translation_group, existing);
	}
	if (selections.size === 0) return;

	const childIds = [...new Set([...selections.values()].flat())];
	const childGroups = new Map<string, string>();
	for (const batch of chunks(childIds, SQL_BATCH_SIZE)) {
		// oxlint-disable-next-line no-await-in-loop -- one statement per bind-parameter batch
		const resolved = await sql<{ id: string; translation_group: string | null }>`
			SELECT id, translation_group
			FROM ${sql.ref(childTable)}
			WHERE id IN (${sql.join(batch)})
		`.execute(db);
		for (const row of resolved.rows) {
			if (row.translation_group) childGroups.set(row.id, row.translation_group);
		}
	}

	const now = currentTimestampValue(db);
	const rows: Array<{ parentGroup: string; childGroup: string; sortOrder: number }> = [];
	for (const parentGroup of [...selections.keys()].toSorted()) {
		const groups: string[] = [];
		for (const id of selections.get(parentGroup) ?? []) {
			const group = childGroups.get(id);
			// An id whose entry is gone is dropped; its value stays in the column.
			if (group && !groups.includes(group)) groups.push(group);
		}
		const selected = backfill.maxChildren === null ? groups : groups.slice(0, backfill.maxChildren);
		for (const [sortOrder, childGroup] of selected.entries()) {
			rows.push({ parentGroup, childGroup, sortOrder });
		}
	}

	// This runs inside the transaction that binds the field, so an editor binding
	// a field on a large legacy collection waits for it: batch rather than paying
	// a round trip per edge.
	for (const batch of chunks(rows, REFERENCE_INSERT_BATCH_SIZE)) {
		const values = batch.map(
			(row) =>
				sql`(${ulid()}, ${backfill.relationId}, ${row.parentGroup}, ${row.childGroup}, ${row.sortOrder}, ${now})`,
		);
		// oxlint-disable-next-line no-await-in-loop -- one statement per bind-parameter batch
		await sql`
			INSERT INTO ${sql.ref("_emdash_content_references")}
				(id, relation_id, parent_group, child_group, sort_order, created_at)
			VALUES ${sql.join(values)}
			ON CONFLICT DO NOTHING
		`.execute(db);
	}
}
