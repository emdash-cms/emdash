/**
 * Package-internal violations of the target's unique constraints.
 *
 * Each record contributes a key per unique constraint it would occupy on the
 * target. Keys are stored as extra rows of the package index under the kind
 * `unique:<constraint>`, with the key's digest as `id` and the owning record
 * id as `group_id`. Inserting is insert-if-absent, so the first owner of a
 * key wins; any other record whose key row names a different owner collides
 * with it. Retrying a chunk re-inserts the same rows and finds the same
 * owners, so the check is idempotent and needs no memory between chunks.
 */

import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { canonicalJson } from "../format/canonical.js";
import { sha256Hex } from "../format/digest.js";
import type { SitePackageRecord } from "../format/kinds.js";
import { rowsPerInsert } from "../format/limits.js";

export const UNIQUE_CONSTRAINTS = [
	"block_type_slug",
	"block_type_version",
	"entry_slug_locale",
	"entry_active_group_locale",
	"term_name_slug_locale",
	"term_group_locale",
	"taxonomy_def_name_locale",
	"byline_slug_locale",
	"byline_group_locale",
	"byline_principal_locale",
	"byline_field_slug",
	"menu_name_locale",
	"relation_name_locale",
	"relation_group_locale",
	"widget_area_name",
	"section_slug",
	"content_reference_groups",
	"content_byline_entry_byline",
	"media_folder_name_key",
] as const;

export type UniqueConstraint = (typeof UNIQUE_CONSTRAINTS)[number];

/** Key-row kind prefix; never a record kind, so record lookups ignore these rows. */
const KEY_KIND_PREFIX = "unique:";

export interface UniqueKey {
	constraint: UniqueConstraint;
	parts: readonly string[];
}

function key(constraint: UniqueConstraint, ...parts: string[]): UniqueKey {
	return { constraint, parts };
}

/**
 * Postgres `lower()` folds the way JavaScript does for the locales EmDash
 * accepts; SQLite's ASCII-only `lower()` agrees on ASCII locale codes.
 */
function lowerLocale(locale: string): string {
	return locale.toLowerCase();
}

/** Keys a record occupies in the target's unique constraints. */
export function uniqueKeysOf(record: SitePackageRecord): UniqueKey[] {
	switch (record.kind) {
		case "block_type":
			return [key("block_type_slug", record.slug)];
		case "block_type_version":
			return [key("block_type_version", record.blockTypeId, String(record.version))];
		case "entry": {
			const keys: UniqueKey[] = [];
			if (record.slug !== undefined) {
				keys.push(key("entry_slug_locale", record.collection, record.slug, record.locale));
			}
			if (record.deletedAt === undefined && record.translationGroup !== undefined) {
				keys.push(
					key(
						"entry_active_group_locale",
						record.collection,
						record.translationGroup,
						lowerLocale(record.locale),
					),
				);
			}
			return keys;
		}
		case "term": {
			const keys = [key("term_name_slug_locale", record.name, record.slug, record.locale)];
			if (record.translationGroup !== undefined) {
				keys.push(key("term_group_locale", record.translationGroup, record.locale));
			}
			return keys;
		}
		case "taxonomy_def":
			return [key("taxonomy_def_name_locale", record.name, record.locale)];
		case "byline": {
			const keys = [key("byline_slug_locale", record.slug, record.locale)];
			if (record.translationGroup !== undefined) {
				keys.push(key("byline_group_locale", record.translationGroup, record.locale));
			}
			if (record.userPrincipal !== undefined) {
				keys.push(key("byline_principal_locale", record.userPrincipal, record.locale));
			}
			return keys;
		}
		case "byline_field":
			return [key("byline_field_slug", record.slug)];
		case "menu":
			return [key("menu_name_locale", record.name, record.locale)];
		case "relation":
			return [
				key("relation_name_locale", record.name, record.locale),
				key("relation_group_locale", record.translationGroup, record.locale),
			];
		case "widget_area":
			return [key("widget_area_name", record.name)];
		case "section":
			return [key("section_slug", record.slug)];
		case "content_reference":
			return [
				key(
					"content_reference_groups",
					record.relationGroup,
					record.parentGroup,
					record.childGroup,
				),
			];
		case "content_byline":
			return [
				key("content_byline_entry_byline", record.collection, record.entryId, record.bylineGroup),
			];
		case "media_folder":
			return [key("media_folder_name_key", record.nameKey)];
		default:
			return [];
	}
}

export interface KeyedRecord<T> {
	ownerId: string;
	keys: readonly UniqueKey[];
	item: T;
}

export interface UniqueCollision<T> {
	constraint: UniqueConstraint;
	item: T;
	/** Id of the record that holds the key first. */
	holderId: string;
}

/** Most key rows one records chunk can write (1000 records × at most 3 keys). */
export const MAX_KEYS_PER_CHUNK = 3000;

/** Upper bound on the queries {@link findUniqueCollisions} runs for one chunk. */
export const UNIQUE_CHECK_QUERIES =
	Math.ceil(MAX_KEYS_PER_CHUNK / rowsPerInsert(4)) + Math.ceil(MAX_KEYS_PER_CHUNK / SQL_BATCH_SIZE);

/**
 * Record the keys of `records` and return every record whose key is already
 * held by a different record of the package (earlier chunks included).
 */
export async function findUniqueCollisions<T>(
	db: Kysely<Database>,
	operationId: string,
	records: readonly KeyedRecord<T>[],
): Promise<UniqueCollision<T>[]> {
	const rows: Array<{
		kind: string;
		id: string;
		ownerId: string;
		item: T;
		constraint: UniqueConstraint;
	}> = [];
	for (const record of records) {
		for (const unique of record.keys) {
			rows.push({
				kind: `${KEY_KIND_PREFIX}${unique.constraint}`,
				id: await sha256Hex(canonicalJson(unique.parts)),
				ownerId: record.ownerId,
				item: record.item,
				constraint: unique.constraint,
			});
		}
	}
	if (rows.length === 0) return [];

	for (const batch of chunks(rows, rowsPerInsert(4))) {
		await db
			.insertInto("_emdash_transfer_package_index")
			.values(
				batch.map((row) => ({
					operation_id: operationId,
					kind: row.kind,
					id: row.id,
					group_id: row.ownerId,
				})),
			)
			.onConflict((conflict) => conflict.columns(["operation_id", "kind", "id"]).doNothing())
			.execute();
	}

	const holders = new Map<string, string>();
	for (const batch of chunks([...new Set(rows.map((row) => row.id))], SQL_BATCH_SIZE)) {
		const stored = await db
			.selectFrom("_emdash_transfer_package_index")
			.select(["kind", "id", "group_id"])
			.where("operation_id", "=", operationId)
			.where("kind", "like", `${KEY_KIND_PREFIX}%`)
			.where("id", "in", batch)
			.execute();
		for (const row of stored) {
			if (row.group_id !== null) holders.set(`${row.kind}\u0000${row.id}`, row.group_id);
		}
	}

	const collisions: UniqueCollision<T>[] = [];
	for (const row of rows) {
		const holderId = holders.get(`${row.kind}\u0000${row.id}`);
		if (holderId !== undefined && holderId !== row.ownerId) {
			collisions.push({ constraint: row.constraint, item: row.item, holderId });
		}
	}
	return collisions;
}
