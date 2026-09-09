import { type Kysely, sql } from "kysely";

import { columnExists, isPostgres } from "../dialect-helpers.js";

const TABLES = [
	{ name: "options", keys: ["name"] },
	{ name: "_plugin_storage", keys: ["plugin_id", "collection", "id"] },
] as const;

const BACKFILL_PAGE_SIZE = 250;
const DUPLICATE_COLUMN_REGEX =
	/(?:duplicate column|column .* already exists|already exists.*column)/i;

export async function up(db: Kysely<unknown>): Promise<void> {
	for (const table of TABLES) {
		if (await columnExists(db, table.name, "revision")) continue;
		try {
			await db.schema
				.alterTable(table.name)
				.addColumn("revision", "text", (column) => column.notNull().defaultTo("0"))
				.execute();
		} catch (error) {
			if (isDuplicateColumnError(error) && (await columnExists(db, table.name, "revision"))) {
				continue;
			}
			throw error;
		}
	}

	if (isPostgres(db)) {
		await sql`
			CREATE OR REPLACE FUNCTION emdash_plugin_storage_assign_revision()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				IF TG_OP = 'INSERT' THEN
					IF NEW.revision = '0' THEN
						NEW.revision := gen_random_uuid()::text;
					END IF;
				ELSIF NEW.revision = '0' OR NEW.revision = OLD.revision THEN
					NEW.revision := gen_random_uuid()::text;
				END IF;
				RETURN NEW;
			END;
			$$
		`.execute(db);
		for (const table of TABLES) {
			await sql`
				CREATE OR REPLACE TRIGGER ${sql.ref(`emdash_${table.name}_revision`)}
				BEFORE INSERT OR UPDATE ON ${sql.ref(table.name)}
				FOR EACH ROW EXECUTE FUNCTION emdash_plugin_storage_assign_revision()
			`.execute(db);
		}
	} else {
		for (const table of TABLES) {
			const rowKey = sql.join(
				table.keys.map((key) => sql`${sql.ref(key)} = ${sql.ref(`NEW.${key}`)}`),
				sql` AND `,
			);
			await sql`
				CREATE TRIGGER IF NOT EXISTS ${sql.ref(`emdash_${table.name}_revision_insert`)}
				AFTER INSERT ON ${sql.ref(table.name)}
				WHEN NEW.revision = '0'
				BEGIN
					UPDATE ${sql.ref(table.name)} SET revision = lower(hex(randomblob(16)))
					WHERE ${rowKey} AND revision = NEW.revision;
				END
			`.execute(db);
			await sql`
				CREATE TRIGGER IF NOT EXISTS ${sql.ref(`emdash_${table.name}_revision_update`)}
				AFTER UPDATE ON ${sql.ref(table.name)}
				WHEN NEW.revision = '0' OR NEW.revision = OLD.revision
				BEGIN
					UPDATE ${sql.ref(table.name)} SET revision = lower(hex(randomblob(16)))
					WHERE ${rowKey} AND revision = NEW.revision;
				END
			`.execute(db);
		}
	}

	// Old writers must stamp inserts before the backfill cursor can pass their keys.
	for (const table of TABLES) {
		const key = sql`(${sql.join(table.keys.map((column) => sql.ref(column)))})`;
		let cursor: string[] | undefined;
		while (true) {
			const afterCursor = cursor
				? sql`AND ${key} > (${sql.join(cursor.map((value) => sql`${value}`))})`
				: sql``;
			const page = await sql<Record<string, string>>`
				SELECT ${sql.join(table.keys.map((column) => sql.ref(column)))}
				FROM ${sql.ref(table.name)}
				WHERE revision = '0' ${afterCursor}
				ORDER BY ${sql.join(table.keys.map((column) => sql.ref(column)))}
				LIMIT ${BACKFILL_PAGE_SIZE}
			`.execute(db);
			const last = page.rows.at(-1);
			if (!last) break;
			const nextCursor = table.keys.map((column) => last[column]);
			await sql`
				UPDATE ${sql.ref(table.name)}
				SET revision = ${isPostgres(db) ? sql`gen_random_uuid()::text` : sql`lower(hex(randomblob(16)))`}
				WHERE revision = '0' ${afterCursor}
					AND ${key} <= (${sql.join(nextCursor.map((value) => sql`${value}`))})
			`.execute(db);
			cursor = nextCursor;
		}
	}
}

function isDuplicateColumnError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return DUPLICATE_COLUMN_REGEX.test(error.message) || isDuplicateColumnError(error.cause);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
	// Revisions must survive a host rollback while other writers still use them.
}
