import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";

/**
 * Get unique fields for a collection.
 */
export async function getUniqueFields(
	db: Kysely<Database>,
	collectionSlug: string,
): Promise<Array<{ slug: string; required: boolean }>> {
	const collection = await db
		.selectFrom("_emdash_collections")
		.select("id")
		.where("slug", "=", collectionSlug)
		.executeTakeFirst();

	if (!collection) return [];

	const fields = await db
		.selectFrom("_emdash_fields")
		.select(["slug", "required"])
		.where("collection_id", "=", collection.id)
		.where("unique", "=", 1)
		.execute();

	return fields.map((f) => ({ slug: f.slug, required: f.required === 1 }));
}

/**
 * Check for unique field conflicts against the content table AND draft revisions.
 *
 * For revision-enabled collections, draft saves write to the revisions table,
 * not the content table. A content-table-only check would miss draft-vs-draft
 * conflicts. This function checks both sources:
 *   1. Content table columns (catches published/direct-write conflicts)
 *   2. Draft revision JSON data (catches draft-vs-draft conflicts)
 */
export async function checkUniqueFieldConflicts(
	db: Kysely<Database>,
	collectionSlug: string,
	entryId: string,
	data: Record<string, unknown>,
	locale?: string,
): Promise<{ code: string; message: string } | null> {
	const uniqueFields = await getUniqueFields(db, collectionSlug);
	if (uniqueFields.length === 0) return null;

	const tableName = `ec_${collectionSlug}`;
	validateIdentifier(collectionSlug, "collection");

	for (const field of uniqueFields) {
		const value = data[field.slug];
		if (value == null) continue;

		const resolvedLocale = locale ?? "en";
		validateIdentifier(field.slug, "field slug");

		// Check 1: content table (published/direct values)
		const contentConflict = await sql<{ id: string }>`
			SELECT id FROM ${sql.ref(tableName)}
			WHERE ${sql.ref(field.slug)} = ${value}
			AND locale = ${resolvedLocale}
			AND deleted_at IS NULL
			AND id != ${entryId}
			LIMIT 1
		`.execute(db);

		if (contentConflict.rows.length > 0) {
			return {
				code: "CONFLICT",
				message: `Unique constraint violation: field "${field.slug}" value already exists`,
			};
		}

		// Check 2: draft revisions of other entries
		const draftConflict = await sql<{ id: string }>`
			SELECT e.id FROM ${sql.ref(tableName)} e
			JOIN revisions r ON r.id = e.draft_revision_id
			WHERE e.id != ${entryId}
			AND e.deleted_at IS NULL
			AND e.locale = ${resolvedLocale}
			AND json_extract(r.data, ${`$.${field.slug}`}) = ${value}
			LIMIT 1
		`.execute(db);

		if (draftConflict.rows.length > 0) {
			return {
				code: "CONFLICT",
				message: `Unique constraint violation: field "${field.slug}" value already exists`,
			};
		}
	}

	return null;
}
