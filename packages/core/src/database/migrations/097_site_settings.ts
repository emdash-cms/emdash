import { type Kysely, sql } from "kysely";

import { isPostgres } from "../dialect-helpers.js";

const DEFAULT_SITE_ID = "site-default";

export async function up(db: Kysely<unknown>): Promise<void> {
	if (isPostgres(db)) {
		await sql`ALTER TABLE options ALTER COLUMN site_id DROP DEFAULT`.execute(db);
		await sql`ALTER TABLE options ALTER COLUMN site_id DROP NOT NULL`.execute(db);
		await sql`UPDATE options SET site_id = ${DEFAULT_SITE_ID} WHERE name LIKE 'site:%' AND site_id IS NULL`.execute(
			db,
		);
		await sql`UPDATE options SET site_id = NULL
			WHERE name NOT LIKE 'site:%' AND site_id IS NOT NULL`.execute(db);
		await sql`UPDATE options SET name = 'site:' || site_id || ':' || substring(name from 6)
			WHERE name LIKE 'site:%' AND substr(name, 1, length('site:' || site_id || ':')) != ('site:' || site_id || ':')`.execute(
			db,
		);
		await sql`ALTER TABLE options DROP CONSTRAINT IF EXISTS options_shared_site`.execute(db);
		await sql`ALTER TABLE options ADD CONSTRAINT options_shared_site CHECK (
			(name NOT LIKE 'site:%' AND site_id IS NULL)
			OR (site_id IS NOT NULL AND substr(name, 1, length('site:' || site_id || ':')) = ('site:' || site_id || ':'))
		)`.execute(db);
	} else {
		const tables = await db.introspection.getTables();
		const legacy = tables.some((table) => table.name === "options_site_settings_legacy");
		const columns = await sql<{
			name: string;
			notnull: number;
			dflt_value: string | null;
		}>`PRAGMA table_info(options)`.execute(db);
		const siteColumn = columns.rows.find((column) => column.name === "site_id");
		if (!legacy && siteColumn && (siteColumn.dflt_value !== null || siteColumn.notnull !== 0)) {
			await sql`ALTER TABLE options RENAME TO options_site_settings_legacy`.execute(db);
		}
		if (legacy || (siteColumn && (siteColumn.dflt_value !== null || siteColumn.notnull !== 0))) {
			await sql`CREATE TABLE IF NOT EXISTS options (
				name text PRIMARY KEY,
				site_id text,
				value text NOT NULL,
				revision text NOT NULL DEFAULT '0',
				CHECK ((name NOT LIKE 'site:%' AND site_id IS NULL)
					OR (site_id IS NOT NULL AND substr(name, 1, length('site:' || site_id || ':')) = ('site:' || site_id || ':')))
			)`.execute(db);
			await sql`INSERT INTO options (site_id, name, value, revision)
				SELECT CASE WHEN name NOT LIKE 'site:%' THEN NULL
					ELSE COALESCE(site_id, ${DEFAULT_SITE_ID}) END,
				CASE WHEN name LIKE 'site:%' AND substr(name, 1, length('site:' || COALESCE(site_id, ${DEFAULT_SITE_ID}) || ':')) != ('site:' || COALESCE(site_id, ${DEFAULT_SITE_ID}) || ':')
					THEN 'site:' || COALESCE(site_id, ${DEFAULT_SITE_ID}) || ':' || substr(name, 6)
					ELSE name END, value, revision
				FROM options_site_settings_legacy WHERE 1
				ON CONFLICT (name) DO NOTHING`.execute(db);
			await sql`DROP TABLE options_site_settings_legacy`.execute(db);
		}
		await sql`CREATE TRIGGER IF NOT EXISTS emdash_options_revision_insert
			AFTER INSERT ON options WHEN NEW.revision = '0' BEGIN
				UPDATE options SET revision = lower(hex(randomblob(16)))
				WHERE name = NEW.name AND revision = NEW.revision;
			END`.execute(db);
		await sql`CREATE TRIGGER IF NOT EXISTS emdash_options_revision_update
			AFTER UPDATE ON options WHEN NEW.revision = '0' OR NEW.revision = OLD.revision BEGIN
				UPDATE options SET revision = lower(hex(randomblob(16)))
				WHERE name = NEW.name AND revision = NEW.revision;
			END`.execute(db);
	}
	await sql`DROP INDEX IF EXISTS idx_options_site_name`.execute(db);
	await sql`CREATE INDEX IF NOT EXISTS idx_options_site_id ON options (site_id)`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
