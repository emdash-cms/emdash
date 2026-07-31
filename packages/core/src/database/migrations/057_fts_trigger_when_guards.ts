import type { Kysely } from "kysely";
import { sql } from "kysely";

import { isSqlite } from "../dialect-helpers.js";
import { validateIdentifier } from "../validate.js";

/**
 * Migration: Recreate FTS sync triggers with change-detection WHEN guards
 *
 * Background: the FTS update trigger fired on ANY row UPDATE, re-tokenizing
 * the full document even when no indexed column changed. Metadata-only
 * saves (status flips, scheduling, version bumps) and the publish path's
 * rewrite-identical-values UPDATEs paid full re-tokenization on every
 * statement — the dominant driver of save CPU and WAL volume on large
 * documents.
 *
 * This migration drops and recreates the three sync triggers for every
 * search-enabled collection with a WHEN guard on the update trigger that
 * compares raw column values (null-safe IS NOT): the trigger now fires only
 * when an indexed value, the row's locale, or its trash state actually
 * changed. Index contents are untouched — no repopulate needed.
 *
 * The trigger SQL emitted here MUST stay in lock-step with
 * `FTSManager.createTriggers` in `src/search/fts-manager.ts`. If that
 * changes again, add a new migration rather than editing this one —
 * migrations are forward-only.
 *
 * Postgres: no-op. FTS5 is SQLite-only.
 *
 * D1: idempotent — DROP IF EXISTS / CREATE IF NOT EXISTS, so concurrent
 * migrators converge.
 */

interface CollectionRow {
	slug: string;
	search_config: string | null;
}

interface FieldRow {
	slug: string;
	type: string;
}

export async function up(db: Kysely<unknown>): Promise<void> {
	if (!isSqlite(db)) return;

	const collections = await sql<CollectionRow>`
		SELECT slug, search_config FROM _emdash_collections
		WHERE search_config IS NOT NULL
	`.execute(db);

	for (const collection of collections.rows) {
		if (!isSearchEnabled(collection.search_config)) continue;

		try {
			validateIdentifier(collection.slug, "collection slug");
		} catch (error) {
			console.warn(
				`[migration 057] skipping trigger rebuild for collection "${collection.slug}": ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			continue;
		}

		const fields = await getSearchableFields(db, collection.slug);
		if (fields.length === 0) continue;

		await recreateTriggers(db, collection.slug, fields);
	}
}

/**
 * Forward-only. Down is a no-op: the guarded triggers remain correct for
 * older code, they just skip no-op re-tokenizations.
 */
export async function down(_db: Kysely<unknown>): Promise<void> {
	// no-op
}

function isSearchEnabled(searchConfig: string | null): boolean {
	if (!searchConfig) return false;
	try {
		const parsed: unknown = JSON.parse(searchConfig);
		return (
			typeof parsed === "object" &&
			parsed !== null &&
			"enabled" in parsed &&
			parsed.enabled === true
		);
	} catch {
		return false;
	}
}

async function getSearchableFields(
	db: Kysely<unknown>,
	collectionSlug: string,
): Promise<FieldRow[]> {
	const rows = await sql<FieldRow>`
		SELECT f.slug, f.type FROM _emdash_fields f
		INNER JOIN _emdash_collections c ON c.id = f.collection_id
		WHERE c.slug = ${collectionSlug} AND f.searchable = 1
	`.execute(db);

	const out: FieldRow[] = [];
	for (const row of rows.rows) {
		try {
			validateIdentifier(row.slug, "searchable field name");
			out.push(row);
		} catch {
			console.warn(
				`[migration 057] skipping invalid searchable field "${row.slug}" on collection "${collectionSlug}"`,
			);
		}
	}
	return out;
}

/** Indexed-value expression for one field; lock-step with FTSManager.searchValueExpr. */
function searchValueExpr(ref: string, fieldType: string): string {
	if (fieldType !== "portableText") return ref;
	return (
		`CASE WHEN ${ref} IS NULL THEN NULL ` +
		`WHEN json_valid(${ref}) THEN (` +
		`SELECT group_concat(j.value, ' ') FROM json_tree(${ref}) AS j ` +
		`WHERE j.key IN ('text', 'alt', 'caption', 'code') AND j.type = 'text') ` +
		`ELSE ${ref} END`
	);
}

async function recreateTriggers(
	db: Kysely<unknown>,
	collectionSlug: string,
	fields: FieldRow[],
): Promise<void> {
	const ftsTable = `_emdash_fts_${collectionSlug}`;
	const contentTable = `ec_${collectionSlug}`;
	const slugs = fields.map((f) => f.slug);
	const fieldList = slugs.join(", ");
	const newValueList = fields.map((f) => searchValueExpr(`NEW.${f.slug}`, f.type)).join(", ");
	const changedCondition = ["deleted_at", "locale", ...slugs]
		.map((f) => `OLD.${f} IS NOT NEW.${f}`)
		.join(" OR ");

	await sql.raw(`DROP TRIGGER IF EXISTS "${ftsTable}_insert"`).execute(db);
	await sql.raw(`DROP TRIGGER IF EXISTS "${ftsTable}_update"`).execute(db);
	await sql.raw(`DROP TRIGGER IF EXISTS "${ftsTable}_delete"`).execute(db);

	await sql
		.raw(`
		CREATE TRIGGER IF NOT EXISTS "${ftsTable}_insert"
		AFTER INSERT ON "${contentTable}"
		WHEN NEW.deleted_at IS NULL
		BEGIN
			INSERT OR REPLACE INTO "${ftsTable}"(rowid, id, locale, ${fieldList})
			VALUES (NEW.rowid, NEW.id, NEW.locale, ${newValueList});
		END
	`)
		.execute(db);

	await sql
		.raw(`
		CREATE TRIGGER IF NOT EXISTS "${ftsTable}_update"
		AFTER UPDATE ON "${contentTable}"
		WHEN ${changedCondition}
		BEGIN
			DELETE FROM "${ftsTable}" WHERE rowid = OLD.rowid;
			INSERT INTO "${ftsTable}"(rowid, id, locale, ${fieldList})
			SELECT NEW.rowid, NEW.id, NEW.locale, ${newValueList}
			WHERE NEW.deleted_at IS NULL;
		END
	`)
		.execute(db);

	await sql
		.raw(`
		CREATE TRIGGER IF NOT EXISTS "${ftsTable}_delete"
		AFTER DELETE ON "${contentTable}"
		BEGIN
			DELETE FROM "${ftsTable}" WHERE rowid = OLD.rowid;
		END
	`)
		.execute(db);
}
