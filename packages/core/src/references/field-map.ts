/**
 * The reference fields a collection carries, for the public query path.
 *
 * `referenceFieldConstraints` (api/handlers) answers the write question — how
 * many entries may a field select, and is it required. Rendering asks a
 * different one: which collection do I load, and which end of the relation am I
 * standing on. Both read the same rows; keeping them apart keeps the render
 * path off the relation table, which the constraints map has to read for its
 * limits.
 */

import { sql, type Kysely } from "kysely";

import { jsonExtractExpr } from "../database/dialect-helpers.js";
import type { Database } from "../database/types.js";
import { getDb } from "../loader.js";
import { cachedQuery, CacheNamespace } from "../object-cache/index.js";
import { requestCached } from "../request-cache.js";
import { isMissingColumnError, isMissingTableError } from "../utils/db-errors.js";

/** One reference field, as a render needs it. */
export interface ReferenceFieldBinding {
	/** Field slug — the key a caller names a selection under. */
	slug: string;
	/** Relation slug the field binds to. */
	relation: string;
	/**
	 * The relation's id, read in the same statement as the binding. Rendering
	 * pages the link table by id, so carrying it here is what keeps a field's
	 * cost at one link read rather than a slug lookup and then the read.
	 */
	relationId: string;
	/** Which end of the relation this field's own collection sits on. */
	side: "parent" | "child";
	/** The collection at the other end. */
	targetCollection: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A collection's field slugs and its bound reference fields, from one read. */
interface FieldIndexSnapshot {
	slugs: string[];
	bindings: ReferenceFieldBinding[];
}

export interface FieldIndex {
	/** Every field slug on the collection; undefined before the schema tables exist. */
	slugs: ReadonlySet<string> | undefined;
	/** Every bound reference field, by field slug. */
	bindings: Map<string, ReferenceFieldBinding>;
}

async function loadFieldIndex(
	db: Kysely<Database>,
	collection: string,
): Promise<FieldIndexSnapshot | null> {
	// The relation's id joins in here rather than being looked up per field at
	// render time: the field stores a slug, but the link table is keyed by id.
	const relationSlug = jsonExtractExpr(db, "validation", "relation");
	let rows: { slug: string; type: string; validation: string | null; relation_id: string | null }[];
	try {
		const result = await sql<{
			slug: string;
			type: string;
			validation: string | null;
			relation_id: string | null;
		}>`
			SELECT f.slug AS slug, f.type AS type, f.validation AS validation, r.id AS relation_id
			FROM ${sql.ref("_emdash_fields")} AS f
			INNER JOIN ${sql.ref("_emdash_collections")} AS c ON c.id = f.collection_id
			LEFT JOIN ${sql.ref("_emdash_relations")} AS r
				ON f.type = 'reference' AND r.slug = ${sql.raw(relationSlug)}
			WHERE c.slug = ${collection}
		`.execute(db);
		rows = result.rows;
	} catch (error) {
		// A partial schema is transient; don't retain its degraded result in cache.
		if (isMissingTableError(error) || isMissingColumnError(error)) return null;
		throw error;
	}

	const bindings: ReferenceFieldBinding[] = [];
	for (const row of rows) {
		if (row.type !== "reference" || !row.validation) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.validation);
		} catch {
			continue;
		}
		if (!isRecord(parsed)) continue;
		const { relation, targetCollection } = parsed;
		// A field with neither is unbound: it keeps its own column, and its value
		// is already in `data`. There is nothing to resolve. Nor is there when the
		// named relation is gone — the join leaves no id to page by.
		if (typeof relation !== "string" || typeof targetCollection !== "string") continue;
		if (!row.relation_id) continue;
		bindings.push({
			slug: row.slug,
			relation,
			relationId: row.relation_id,
			targetCollection,
			side: parsed.relationSide === "child" ? "child" : "parent",
		});
	}
	return { slugs: rows.map((row) => row.slug), bindings };
}

/**
 * The field slugs and bound reference fields of `collection`, or undefined
 * slugs when the schema tables are not there yet.
 *
 * One read serves every schema check a list or entry read makes: reference
 * selections, `where` keys and `fields` names. Cached twice over: once per
 * request, and once in the schema object-cache namespace, which a schema edit
 * already bumps. A render that makes none of those checks never issues it.
 */
export function getFieldIndex(collection: string): Promise<FieldIndex> {
	return requestCached(`field-index:${collection}`, async () => {
		const snapshot = await cachedQuery({
			namespace: CacheNamespace.SCHEMA,
			key: `field-index:${collection}`,
			load: async () => loadFieldIndex(await getDb(), collection),
			cacheable: (value) => value !== null,
		});
		return {
			slugs: snapshot ? new Set(snapshot.slugs) : undefined,
			bindings: new Map((snapshot?.bindings ?? []).map((binding) => [binding.slug, binding])),
		};
	});
}

/** Every bound reference field on `collection`, by field slug. See {@link getFieldIndex}. */
export async function getReferenceFieldMap(
	collection: string,
): Promise<Map<string, ReferenceFieldBinding>> {
	return (await getFieldIndex(collection)).bindings;
}
