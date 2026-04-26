/**
 * Field-level validation for content create / update.
 *
 * Wires the existing `generateZodSchema()` pipeline (`schema/zod-generator.ts`)
 * into the handler boundary so REST and MCP both get the same enforcement:
 *
 *  - required fields must be present and non-empty
 *  - select / multiSelect values must match the configured options
 *  - reference fields must resolve to a real, non-trashed target
 *
 * Errors surface as `{ code: "VALIDATION_ERROR", message }` with all
 * offending fields listed in one message so callers can fix everything in
 * a single round trip.
 */

import { sql, type Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import { SchemaRegistry } from "../../schema/registry.js";
import type { Field } from "../../schema/types.js";
import { generateZodSchema } from "../../schema/zod-generator.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { isMissingTableError } from "../../utils/db-errors.js";

type ValidationResult =
	| { ok: true }
	| { ok: false; error: { code: "VALIDATION_ERROR" | "COLLECTION_NOT_FOUND"; message: string } };

/** Treat `undefined`, `null`, and `""` as "not set". */
function isMissing(value: unknown): boolean {
	return value === undefined || value === null || value === "";
}

/**
 * Resolve the target collection slug for a reference field.
 *
 * Schema-defined reference fields (the static `reference()` factory in
 * `fields/reference.ts`) put the target in `options.collection`. The MCP
 * `schema_create_field` tool also puts it there. Tests and some admin paths
 * stash it inside `validation.collection` directly; we accept both.
 */
function getReferenceTargetCollection(field: Field): string | undefined {
	const fromOptions = field.options?.collection;
	if (typeof fromOptions === "string" && fromOptions.length > 0) return fromOptions;
	const validation = field.validation;
	if (validation && "collection" in validation) {
		const fromValidation: unknown = (validation as { collection?: unknown }).collection;
		if (typeof fromValidation === "string" && fromValidation.length > 0) return fromValidation;
	}
	return undefined;
}

/**
 * Format a Zod issue path into a human-readable field reference, e.g.
 * `tags`, `tags.1`, `image.alt`.
 */
function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
	if (path.length === 0) return "(root)";
	return path.map((seg) => String(seg)).join(".");
}

/**
 * Validate `data` against the collection's field definitions.
 *
 * `partial: true` switches Zod into partial mode so updates can include
 * only the fields being changed without tripping required-field errors on
 * fields the caller didn't touch. Required fields that ARE present in
 * partial-mode data still get the empty-string check below.
 */
export async function validateContentData(
	db: Kysely<Database>,
	collection: string,
	data: Record<string, unknown>,
	options: { partial?: boolean } = {},
): Promise<ValidationResult> {
	const registry = new SchemaRegistry(db);
	const collectionWithFields = await registry.getCollectionWithFields(collection);
	if (!collectionWithFields) {
		return {
			ok: false,
			error: {
				code: "COLLECTION_NOT_FOUND",
				message: `Collection '${collection}' not found`,
			},
		};
	}

	const issues: string[] = [];

	// Detect unknown keys explicitly so callers get a useful error rather
	// than silently dropped data. Leading-underscore keys (e.g. `_slug`,
	// `_rev`) are reserved for internal handler/runtime use and aren't real
	// fields; skip them.
	const knownFields = new Set(collectionWithFields.fields.map((f) => f.slug));
	for (const key of Object.keys(data)) {
		if (key.startsWith("_")) continue;
		if (!knownFields.has(key)) {
			issues.push(`${key}: unknown field on collection '${collection}'`);
		}
	}

	// Zod handles type, enum, length and missing-required (in non-partial
	// mode) checks. Empty-string handling for required string fields is
	// done as a separate pass below since Zod's `z.string()` accepts "".
	const baseSchema = generateZodSchema(collectionWithFields);
	const schema = options.partial ? baseSchema.partial() : baseSchema;
	const parsed = schema.safeParse(data);
	if (!parsed.success) {
		for (const issue of parsed.error.issues) {
			issues.push(`${formatIssuePath(issue.path)}: ${issue.message}`);
		}
	}

	// Empty-string-on-required check. In create mode (partial=false) Zod
	// already catches missing/null for required fields, but `z.string()`
	// happily accepts "". In update mode (partial=true) the field is only
	// checked if it's present in `data`.
	for (const field of collectionWithFields.fields) {
		if (!field.required) continue;
		const present = Object.hasOwn(data, field.slug);
		if (options.partial && !present) continue;
		if (data[field.slug] === "") {
			issues.push(`${field.slug}: required (empty value not allowed)`);
		}
	}

	// Reference target existence. Only check fields that:
	//   - have a value (non-missing) in `data`
	//   - have a resolvable target collection
	//   - in partial mode: are present in `data`
	// Batch one IN-query per target collection to keep round-trips low.
	const refsByTarget = new Map<string, { field: string; id: string }[]>();
	for (const field of collectionWithFields.fields) {
		if (field.type !== "reference") continue;
		if (options.partial && !Object.hasOwn(data, field.slug)) continue;
		const value = data[field.slug];
		if (isMissing(value)) continue;
		if (typeof value !== "string") continue; // Zod will have flagged this already
		const target = getReferenceTargetCollection(field);
		if (!target) continue;
		const list = refsByTarget.get(target) ?? [];
		list.push({ field: field.slug, id: value });
		refsByTarget.set(target, list);
	}

	for (const [target, refs] of refsByTarget) {
		// Validate the target collection slug before interpolating into raw
		// SQL — defense-in-depth even though slugs are already validated at
		// schema-create time.
		try {
			validateIdentifier(target, "reference target collection");
		} catch {
			for (const ref of refs) {
				issues.push(`${ref.field}: invalid reference target collection '${target}'`);
			}
			continue;
		}

		const ids = [...new Set(refs.map((r) => r.id))];
		const tableName = `ec_${target}`;

		// Chunk the IN clause to stay below D1's bind-parameter limit. One
		// reference per request is the common case today; chunking makes the
		// helper safe if a future multiSelect-of-references is added.
		const found = new Set<string>();
		let targetTableMissing = false;
		for (const idChunk of chunks(ids, SQL_BATCH_SIZE)) {
			try {
				const rows = await sql<{ id: string }>`
					SELECT id FROM ${sql.ref(tableName)}
					WHERE id IN (${sql.join(idChunk)})
					AND deleted_at IS NULL
				`.execute(db);
				for (const row of rows.rows) {
					found.add(row.id);
				}
			} catch (error) {
				// Missing table = the target collection table doesn't exist
				// (orphan reference). Treat all those references as missing.
				// Any other DB error (permissions, connection, syntax) must
				// propagate — silently dropping data integrity errors as
				// "not found" is exactly the bug F5 fixes.
				if (isMissingTableError(error)) {
					targetTableMissing = true;
					break;
				}
				throw error;
			}
		}
		if (targetTableMissing) {
			for (const ref of refs) {
				issues.push(`${ref.field}: target '${ref.id}' not found in collection '${target}'`);
			}
			continue;
		}
		for (const ref of refs) {
			if (!found.has(ref.id)) {
				issues.push(`${ref.field}: target '${ref.id}' not found in collection '${target}'`);
			}
		}
	}

	if (issues.length === 0) return { ok: true };
	return {
		ok: false,
		error: {
			code: "VALIDATION_ERROR",
			message: issues.join("; "),
		},
	};
}
