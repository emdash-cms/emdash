import { type Kysely, sql } from "kysely";
import { ulid } from "ulidx";

import type { Database } from "../../src/database/types.js";

export interface LegacyReferenceFieldOptions {
	/** Written to `options.collection`, the only place a pre-relations field named its target. */
	targetCollection?: string;
	/** `options.allowMultiple`; omitted entirely when undefined, as most legacy rows have it. */
	allowMultiple?: boolean;
	/** Written to `validation.targetCollection` instead of `options.collection`. */
	validationTargetCollection?: string;
	indexed?: boolean;
	searchable?: boolean;
	required?: boolean;
	label?: string;
}

/**
 * Build a reference field in the shape it had before relations existed: a
 * `_emdash_fields` row naming its target in `options.collection`, no
 * `validation.relation`, and a real TEXT column on the content table.
 *
 * Written with raw statements rather than through `SchemaRegistry` so a test
 * fixture never depends on the behaviour under test.
 */
export async function createLegacyReferenceField(
	db: Kysely<Database>,
	collectionSlug: string,
	fieldSlug: string,
	options: LegacyReferenceFieldOptions = {},
): Promise<void> {
	const collection = await db
		.selectFrom("_emdash_collections")
		.select("id")
		.where("slug", "=", collectionSlug)
		.executeTakeFirstOrThrow();

	const fieldOptions: Record<string, unknown> = {};
	if (options.targetCollection) fieldOptions.collection = options.targetCollection;
	if (options.allowMultiple !== undefined) fieldOptions.allowMultiple = options.allowMultiple;

	const validation = options.validationTargetCollection
		? { targetCollection: options.validationTargetCollection }
		: null;

	await db
		.insertInto("_emdash_fields")
		.values({
			id: ulid(),
			collection_id: collection.id,
			slug: fieldSlug,
			label: options.label ?? "Author",
			type: "reference",
			column_type: "TEXT",
			required: options.required ? 1 : 0,
			unique: 0,
			default_value: null,
			validation: validation ? JSON.stringify(validation) : null,
			widget: null,
			options: Object.keys(fieldOptions).length > 0 ? JSON.stringify(fieldOptions) : null,
			sort_order: 10,
			indexed: options.indexed ? 1 : 0,
			searchable: options.searchable ? 1 : 0,
		})
		.execute();

	await sql`ALTER TABLE ${sql.ref(`ec_${collectionSlug}`)} ADD COLUMN ${sql.ref(fieldSlug)} text`.execute(
		db,
	);
}
