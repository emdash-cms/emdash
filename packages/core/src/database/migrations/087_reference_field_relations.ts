import type { Kysely } from "kysely";
import { sql } from "kysely";
import { ulid } from "ulidx";

import { currentTimestampValue, tableExists } from "../dialect-helpers.js";
import { validateIdentifier } from "../validate.js";

/**
 * Give a reference field created before relations existed the relation it needs
 * to work as a picker.
 *
 * Such a field names its target in `options.collection` and keeps a TEXT column
 * holding either one entry id or a JSON array of them. A field with no
 * `validation.relation` still reads and writes that column, so this migration is
 * an upgrade rather than a repair: it creates one relation per field, copies the
 * column's ids in as edges, and records the relation on the field row.
 *
 * The column is left in place. Nothing reads it once the field is bound, but
 * dropping it would discard the only copy of any value whose target entry could
 * not be resolved.
 *
 * Writing `validation.relation` is the completion fence: a rerun sees it and
 * skips the field, so a lost D1 response cannot wire a field twice. Relation
 * creation and the edge copy are each idempotent on their own — the relation is
 * created under the field's own id, so a rerun recognizes its own half-finished
 * work and anything else at that slug as somebody else's, and the edge table's
 * unique constraint absorbs a repeated copy.
 *
 * A field is left unbound when its target cannot be resolved, when it is indexed
 * or searchable, when its relation slug is taken, and when its locale rows
 * disagree about what it selects. Such a field keeps behaving exactly as it did;
 * an editor can bind it later by setting a target collection in the schema
 * editor.
 *
 * The edge copy below is duplicated from `backfillReferenceEdges`, which the
 * schema handler runs for that manual binding, and it batches with a local
 * constant rather than `SQL_BATCH_SIZE`. A migration reaches only for modules
 * nothing outside the runner imports: the bundler otherwise puts a shared module
 * in a chunk that cycles with the runner's, and the built package throws on
 * import. A shipped migration has to keep batching the way it did anyway.
 */

/** Ids per statement while resolving children, within D1's 100-parameter ceiling. */
const ID_BATCH_SIZE = 50;

/** Edges per INSERT: each binds six values, within D1's 100-parameter ceiling. */
const EDGE_INSERT_BATCH_SIZE = Math.floor(100 / 6);

/** Parsed `_emdash_fields` row for a reference field with no relation. */
interface LegacyReferenceField {
	fieldId: string;
	collectionSlug: string;
	collectionLabel: string;
	collectionLabelSingular: string | null;
	fieldSlug: string;
	fieldLabel: string;
	validation: Record<string, unknown>;
	targetCollection: string;
	allowMultiple: boolean;
}

interface FieldRow {
	field_id: string;
	field_slug: string;
	field_label: string;
	validation: string | null;
	options: string | null;
	indexed: number | null;
	searchable: number | null;
	collection_slug: string;
	collection_label: string;
	collection_label_singular: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseJsonObject(value: string | null): Record<string, unknown> {
	if (!value) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
	const value = source[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The ids one legacy column value holds: a JSON array for a multiple-reference
 * field (`serializeValue` stringifies it), or the id itself.
 */
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
 * What one field's column holds, per translation group, as the translation
 * groups it selects — or `null` when its locale rows disagree.
 *
 * A link belongs to the group, not to one locale's row of it, so a field whose
 * locale rows made different choices has no selection this can carry over: the
 * union would hand each locale the other's entries, and keeping one locale's
 * answer would throw the other's away. Neither is the selection the site has, so
 * such a field is left unbound with its column intact, for an editor to settle
 * and bind by hand.
 *
 * Disagreement is judged on translation groups rather than on the ids in the
 * column, because that is what an edge names: two locale rows pointing at their
 * own locale's row of one entry have made the same choice twice, which is
 * exactly how a localized site holds a reference. Comparing ids would read that
 * as a conflict and leave the field unbound.
 *
 * A row that chose nothing does not disagree with one that did — it is the same
 * group's single answer, arrived at once.
 */
async function readColumnSelections(
	db: Kysely<unknown>,
	field: LegacyReferenceField,
): Promise<Map<string, string[]> | null> {
	const parentTable = `ec_${field.collectionSlug}`;
	const childTable = `ec_${field.targetCollection}`;
	validateIdentifier(parentTable, "content table name");
	validateIdentifier(childTable, "content table name");
	validateIdentifier(field.fieldSlug, "content field name");

	if (!(await tableExists(db, parentTable)) || !(await tableExists(db, childTable))) {
		return new Map();
	}

	const entries = await sql<{ translation_group: string | null; value: unknown }>`
		SELECT translation_group, ${sql.ref(field.fieldSlug)} AS value
		FROM ${sql.ref(parentTable)}
		WHERE ${sql.ref(field.fieldSlug)} IS NOT NULL
		ORDER BY locale, id
	`.execute(db);

	const rows: Array<{ parentGroup: string; ids: string[] }> = [];
	for (const entry of entries.rows) {
		if (!entry.translation_group) continue;
		const ids = parseColumnIds(entry.value);
		if (ids.length === 0) continue;
		rows.push({ parentGroup: entry.translation_group, ids });
	}
	if (rows.length === 0) return new Map();

	const childGroups = await resolveChildGroups(db, childTable, [
		...new Set(rows.flatMap((row) => row.ids)),
	]);

	// Parent group -> the child translation groups it selects, in order.
	const selections = new Map<string, string[]>();
	for (const row of rows) {
		const groups: string[] = [];
		for (const id of row.ids) {
			const group = childGroups.get(id);
			// An id whose entry is gone is dropped; its value stays in the column.
			if (group && !groups.includes(group)) groups.push(group);
		}

		const existing = selections.get(row.parentGroup);
		if (!existing) {
			selections.set(row.parentGroup, groups);
			continue;
		}
		if (
			existing.length !== groups.length ||
			existing.some((group, index) => group !== groups[index])
		) {
			return null;
		}
	}
	return selections;
}

/** The translation group each of `ids` belongs to, for the ids that still resolve. */
async function resolveChildGroups(
	db: Kysely<unknown>,
	childTable: string,
	ids: string[],
): Promise<Map<string, string>> {
	const childGroups = new Map<string, string>();
	for (let offset = 0; offset < ids.length; offset += ID_BATCH_SIZE) {
		const batch = ids.slice(offset, offset + ID_BATCH_SIZE);
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
	return childGroups;
}

/**
 * Copy one field's resolved selections in as edges.
 *
 * Edges an interrupted run already wrote are not sent again, so a rerun only
 * pays for what is still missing and a copy too large for one invocation
 * finishes over several.
 */
async function backfillEdges(
	db: Kysely<unknown>,
	relationId: string,
	maxChildren: number | null,
	selections: Map<string, string[]>,
): Promise<void> {
	if (selections.size === 0) return;

	const copied = await sql<{ parent_group: string; child_group: string }>`
		SELECT parent_group, child_group
		FROM ${sql.ref("_emdash_content_references")}
		WHERE relation_id = ${relationId}
	`.execute(db);
	const copiedByParent = new Map<string, Set<string>>();
	for (const edge of copied.rows) {
		const children = copiedByParent.get(edge.parent_group) ?? new Set<string>();
		children.add(edge.child_group);
		copiedByParent.set(edge.parent_group, children);
	}

	const rows: Array<{ parentGroup: string; childGroup: string; sortOrder: number }> = [];
	for (const parentGroup of [...selections.keys()].toSorted()) {
		const groups = selections.get(parentGroup) ?? [];
		// The locale rows agree by now, so this only cuts a column that held more
		// ids than the field's own shape allows.
		const selected = maxChildren === null ? groups : groups.slice(0, maxChildren);
		const alreadyCopied = copiedByParent.get(parentGroup);

		for (const [sortOrder, childGroup] of selected.entries()) {
			if (alreadyCopied?.has(childGroup)) continue;
			rows.push({ parentGroup, childGroup, sortOrder });
		}
	}

	const now = currentTimestampValue(db);
	for (let offset = 0; offset < rows.length; offset += EDGE_INSERT_BATCH_SIZE) {
		const values = rows
			.slice(offset, offset + EDGE_INSERT_BATCH_SIZE)
			.map(
				(row) =>
					sql`(${ulid()}, ${relationId}, ${row.parentGroup}, ${row.childGroup}, ${row.sortOrder}, ${now})`,
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

/**
 * Which reference fields to bind, and to what.
 *
 * A field is skipped when its target cannot be resolved to an existing
 * collection, and when it is `indexed` or `searchable`. Both flags mean the site
 * queries the column through an index — a content-list field filter, or the FTS
 * table — and binding the field freezes that column, so the migration leaves
 * those fields alone rather than changing the results of a query the site
 * already runs.
 */
async function findLegacyReferenceFields(db: Kysely<unknown>): Promise<{
	fields: LegacyReferenceField[];
	/** Relation slugs some reference field already binds, which none of these may take. */
	boundSlugs: Set<string>;
}> {
	const fields = await sql<FieldRow>`
		SELECT f.id AS field_id, f.slug AS field_slug, f.label AS field_label,
		       f.validation, f.options, f.indexed, f.searchable,
		       c.slug AS collection_slug, c.label AS collection_label,
		       c.label_singular AS collection_label_singular
		FROM ${sql.ref("_emdash_fields")} AS f
		INNER JOIN ${sql.ref("_emdash_collections")} AS c ON c.id = f.collection_id
		WHERE f.type = 'reference'
		ORDER BY c.slug, f.slug
	`.execute(db);

	const collections = await sql<{ slug: string }>`
		SELECT slug FROM ${sql.ref("_emdash_collections")}
	`.execute(db);
	const known = new Set(collections.rows.map((row) => row.slug));

	const legacy: LegacyReferenceField[] = [];
	const boundSlugs = new Set<string>();
	for (const row of fields.rows) {
		const validation = parseJsonObject(row.validation);
		const boundTo = readString(validation, "relation");
		if (boundTo) {
			boundSlugs.add(boundTo);
			continue;
		}
		if (row.indexed === 1 || row.searchable === 1) continue;

		const options = parseJsonObject(row.options);
		const targetCollection =
			readString(options, "collection") ??
			readString(validation, "targetCollection") ??
			readString(validation, "collection");
		if (!targetCollection || !known.has(targetCollection)) continue;

		legacy.push({
			fieldId: row.field_id,
			collectionSlug: row.collection_slug,
			collectionLabel: row.collection_label,
			collectionLabelSingular: row.collection_label_singular,
			fieldSlug: row.field_slug,
			fieldLabel: row.field_label,
			validation,
			targetCollection,
			allowMultiple: options.allowMultiple === true,
		});
	}
	return { fields: legacy, boundSlugs };
}

export async function up(db: Kysely<unknown>): Promise<void> {
	const { fields, boundSlugs } = await findLegacyReferenceFields(db);

	for (const field of fields) {
		const maxChildren = field.allowMultiple ? null : 1;
		const slug = `${field.collectionSlug}_${field.fieldSlug}`.slice(0, 63);

		// Read the column before anything is written: a field whose locale rows
		// disagree has no selection to carry over and must stay unbound, relation
		// and all.
		// oxlint-disable-next-line no-await-in-loop -- one field at a time so a partial run stays restartable
		const selections = await readColumnSelections(db, field);
		if (selections === null) continue;

		// The relation this field would get takes the field's own id, which makes
		// a restart able to recognize its own work: a lost response after the
		// insert leaves a relation this rerun finds by id and finishes, while a
		// relation at the same slug that some other id owns is somebody else's and
		// the field is left unbound for an editor to bind by hand. The slug carries
		// no collision suffix for the same reason — a suffix picked from whatever
		// was free at the time is not something a restart can recompute.
		// oxlint-disable-next-line no-await-in-loop -- each field's relation must exist before its edges
		const existing = await sql<{ id: string }>`
			SELECT id FROM ${sql.ref("_emdash_relations")} WHERE slug = ${slug}
		`.execute(db);

		const relationId = field.fieldId;
		const claimed = existing.rows[0];
		if (claimed) {
			if (claimed.id !== relationId || boundSlugs.has(slug)) continue;
		} else {
			// oxlint-disable-next-line no-await-in-loop -- one relation per field
			await sql`
				INSERT INTO ${sql.ref("_emdash_relations")}
					(id, slug, parent_collection, child_collection, parent_label, parent_label_singular,
					 child_label, max_children_per_parent, created_at, updated_at)
				VALUES (${relationId}, ${slug}, ${field.collectionSlug}, ${field.targetCollection},
				        ${field.collectionLabel}, ${field.collectionLabelSingular},
				        ${field.fieldLabel}, ${maxChildren},
				        ${currentTimestampValue(db)}, ${currentTimestampValue(db)})
			`.execute(db);
		}

		// oxlint-disable-next-line no-await-in-loop -- edges depend on the relation above
		await backfillEdges(db, relationId, maxChildren, selections);

		const validation = {
			...field.validation,
			relation: slug,
			relationSide: "parent",
			targetCollection: field.targetCollection,
			multiple: field.allowMultiple,
		};
		// Last, and alone: this is what a rerun reads to skip the field.
		// oxlint-disable-next-line no-await-in-loop -- one field at a time so a partial run stays restartable
		await sql`
			UPDATE ${sql.ref("_emdash_fields")}
			SET validation = ${JSON.stringify(validation)}
			WHERE id = ${field.fieldId}
		`.execute(db);

		// Two long field slugs on one collection can truncate to the same relation
		// slug; without this the second would bind to the first's relation and
		// their selections would merge.
		boundSlugs.add(slug);
	}
}

export async function down(_db: Kysely<unknown>): Promise<void> {
	// no-op: the relations and edges this created are indistinguishable from ones
	// an editor made afterwards, and the columns it read were left in place, so
	// there is nothing to restore and nothing safe to remove.
}
