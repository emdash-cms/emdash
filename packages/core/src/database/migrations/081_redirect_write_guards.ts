import { type Kysely, sql } from "kysely";

import { columnExists, isPostgres } from "../dialect-helpers.js";

const DUPLICATE_COLUMN_REGEX =
	/(?:duplicate column|column .* already exists|already exists.*column)/i;

async function addColumnIfMissing(
	db: Kysely<unknown>,
	column: "config_revision" | "source_guard" | "write_generation",
): Promise<void> {
	if (await columnExists(db, "_emdash_redirects", column)) return;
	try {
		await db.schema
			.alterTable("_emdash_redirects")
			.addColumn(column, column === "config_revision" ? "text" : "integer", (builder) =>
				builder.notNull().defaultTo(column === "config_revision" ? "0" : 0),
			)
			.execute();
	} catch (error) {
		if (
			error instanceof Error &&
			DUPLICATE_COLUMN_REGEX.test(error.message) &&
			(await columnExists(db, "_emdash_redirects", column))
		) {
			return;
		}
		throw error;
	}
}

export async function up(db: Kysely<unknown>): Promise<void> {
	await addColumnIfMissing(db, "config_revision");
	await addColumnIfMissing(db, "source_guard");
	await addColumnIfMissing(db, "write_generation");

	// Preserve any historical duplicate rows, but nominate one existing row
	// per source for the uniqueness constraint. New rows and source-changing
	// updates set this flag, so they are database-enforced without deleting old data.
	await sql`
		UPDATE _emdash_redirects
		SET source_guard = 1
		WHERE id IN (
			SELECT MIN(id) FROM _emdash_redirects GROUP BY source
		)
		AND source_guard = 0
	`.execute(db);
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_redirects_managed_source
		ON _emdash_redirects (source)
		WHERE source_guard = 1
	`.execute(db);

	await db.schema
		.createTable("_emdash_redirect_write_lock")
		.ifNotExists()
		.addColumn("id", "integer", (column) => column.primaryKey())
		.addColumn("token", "text", (column) => column.notNull())
		.addColumn("expires_at", isPostgres(db) ? "bigint" : "integer", (column) => column.notNull())
		.addColumn("generation", "integer", (column) => column.notNull())
		.execute();
	await sql`
		INSERT INTO _emdash_redirect_write_lock (id, token, expires_at, generation)
		VALUES (1, '', 0, 0)
		ON CONFLICT (id) DO NOTHING
	`.execute(db);

	if (isPostgres(db)) {
		await sql`
			CREATE OR REPLACE FUNCTION emdash_redirect_validate_write()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				PERFORM pg_advisory_xact_lock(1168624763);
				IF TG_OP = 'INSERT' THEN
					NEW.source_guard := 1;
				ELSIF NEW.source <> OLD.source THEN
					NEW.source_guard := 1;
				END IF;
				IF TG_OP = 'UPDATE'
					AND NEW.config_revision IS NOT DISTINCT FROM OLD.config_revision
					AND (
						NEW.source IS DISTINCT FROM OLD.source OR
						NEW.destination IS DISTINCT FROM OLD.destination OR
						NEW.enabled IS DISTINCT FROM OLD.enabled OR
						NEW.is_pattern IS DISTINCT FROM OLD.is_pattern OR
						NEW.type IS DISTINCT FROM OLD.type OR
						NEW.group_name IS DISTINCT FROM OLD.group_name
					)
				THEN
					NEW.config_revision := md5(random()::text || clock_timestamp()::text || NEW.id);
				END IF;
				IF NEW.write_generation <> 0 AND TG_OP = 'INSERT' THEN
					IF NOT EXISTS (
						SELECT 1 FROM _emdash_redirect_write_lock
						WHERE id = 1 AND token <> '' AND generation = NEW.write_generation
					) THEN
						RAISE EXCEPTION 'redirect write lease expired';
					END IF;
				ELSIF TG_OP = 'UPDATE' AND NEW.write_generation IS DISTINCT FROM OLD.write_generation THEN
					IF NOT EXISTS (
						SELECT 1 FROM _emdash_redirect_write_lock
						WHERE id = 1 AND token <> '' AND generation = NEW.write_generation
					) THEN
						RAISE EXCEPTION 'redirect write lease expired';
					END IF;
				END IF;
				IF NEW.enabled = 1 AND NEW.destination <> ''
					AND (TG_OP = 'INSERT' OR NEW.source <> OLD.source OR NEW.destination <> OLD.destination)
					AND EXISTS (
					WITH RECURSIVE chain(source, destination) AS (
						SELECT source, destination FROM _emdash_redirects
						WHERE source = NEW.destination AND enabled = 1
							AND (TG_OP = 'INSERT' OR id <> NEW.id)
						UNION
						SELECT redirect.source, redirect.destination
						FROM _emdash_redirects AS redirect
						JOIN chain ON redirect.source = chain.destination
						WHERE redirect.enabled = 1
							AND (TG_OP = 'INSERT' OR redirect.id <> NEW.id)
					)
					SELECT 1 FROM chain WHERE destination = NEW.source
				) THEN
					RAISE EXCEPTION 'redirect loop';
				END IF;
				RETURN NEW;
			END;
			$$
		`.execute(db);
		await sql`DROP TRIGGER IF EXISTS emdash_redirect_validate_write ON _emdash_redirects`.execute(
			db,
		);
		await sql`
			CREATE TRIGGER emdash_redirect_validate_write
			BEFORE INSERT OR UPDATE OF source, destination, enabled, is_pattern, type, group_name
			ON _emdash_redirects
			FOR EACH ROW EXECUTE FUNCTION emdash_redirect_validate_write()
		`.execute(db);
		await sql`
			CREATE OR REPLACE FUNCTION emdash_redirect_serialize_delete()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				PERFORM pg_advisory_xact_lock(1168624763);
				RETURN OLD;
			END;
			$$
		`.execute(db);
		await sql`DROP TRIGGER IF EXISTS emdash_redirect_serialize_delete ON _emdash_redirects`.execute(
			db,
		);
		await sql`
			CREATE TRIGGER emdash_redirect_serialize_delete
			BEFORE DELETE ON _emdash_redirects
			FOR EACH ROW EXECUTE FUNCTION emdash_redirect_serialize_delete()
		`.execute(db);
	} else {
		await sql`
			CREATE TRIGGER IF NOT EXISTS emdash_redirect_fence_insert
			BEFORE INSERT ON _emdash_redirects
			WHEN NEW.write_generation <> 0 AND NOT EXISTS (
				SELECT 1 FROM _emdash_redirect_write_lock
				WHERE id = 1 AND token <> '' AND generation = NEW.write_generation
			)
			BEGIN
				SELECT RAISE(ABORT, 'redirect write lease expired');
			END
		`.execute(db);
		await sql`
			CREATE TRIGGER IF NOT EXISTS emdash_redirect_fence_update
			BEFORE UPDATE OF source, destination, enabled, is_pattern, type, group_name ON _emdash_redirects
			WHEN NEW.write_generation <> OLD.write_generation
			AND NEW.write_generation <> 0 AND NOT EXISTS (
				SELECT 1 FROM _emdash_redirect_write_lock
				WHERE id = 1 AND token <> '' AND generation = NEW.write_generation
			)
			BEGIN
				SELECT RAISE(ABORT, 'redirect write lease expired');
			END
		`.execute(db);
		await sql`
			CREATE TRIGGER IF NOT EXISTS emdash_redirect_loop_insert
			BEFORE INSERT ON _emdash_redirects
			WHEN NEW.enabled = 1 AND NEW.destination <> ''
			BEGIN
				SELECT CASE WHEN EXISTS (
					WITH RECURSIVE chain(source, destination) AS (
						SELECT source, destination FROM _emdash_redirects
						WHERE source = NEW.destination AND enabled = 1
						UNION
						SELECT redirect.source, redirect.destination
						FROM _emdash_redirects AS redirect
						JOIN chain ON redirect.source = chain.destination
						WHERE redirect.enabled = 1
					)
					SELECT 1 FROM chain WHERE destination = NEW.source
				) THEN RAISE(ABORT, 'redirect loop') END;
			END
		`.execute(db);
		await sql`
			CREATE TRIGGER IF NOT EXISTS emdash_redirect_loop_update
			BEFORE UPDATE OF source, destination ON _emdash_redirects
			WHEN NEW.enabled = 1 AND NEW.destination <> ''
			BEGIN
				SELECT CASE WHEN EXISTS (
					WITH RECURSIVE chain(source, destination) AS (
						SELECT source, destination FROM _emdash_redirects
						WHERE source = NEW.destination AND enabled = 1 AND id <> NEW.id
						UNION
						SELECT redirect.source, redirect.destination
						FROM _emdash_redirects AS redirect
						JOIN chain ON redirect.source = chain.destination
						WHERE redirect.enabled = 1 AND redirect.id <> NEW.id
					)
					SELECT 1 FROM chain WHERE destination = NEW.source
				) THEN RAISE(ABORT, 'redirect loop') END;
			END
		`.execute(db);
		await sql`
			CREATE TRIGGER IF NOT EXISTS emdash_redirect_guard_insert
			AFTER INSERT ON _emdash_redirects
			WHEN NEW.source_guard = 0
			BEGIN
				UPDATE _emdash_redirects SET source_guard = 1 WHERE id = NEW.id;
			END
		`.execute(db);
		await sql`
			CREATE TRIGGER IF NOT EXISTS emdash_redirect_guard_update
			AFTER UPDATE OF source ON _emdash_redirects
			WHEN NEW.source_guard = 0 AND NEW.source <> OLD.source
			BEGIN
				UPDATE _emdash_redirects SET source_guard = 1 WHERE id = NEW.id;
			END
		`.execute(db);
		await sql`
			CREATE TRIGGER IF NOT EXISTS emdash_redirect_revision_update
			AFTER UPDATE OF source, destination, enabled, is_pattern, type, group_name ON _emdash_redirects
			WHEN NEW.config_revision = OLD.config_revision AND (
				NEW.source IS NOT OLD.source OR
				NEW.destination IS NOT OLD.destination OR
				NEW.enabled IS NOT OLD.enabled OR
				NEW.is_pattern IS NOT OLD.is_pattern OR
				NEW.type IS NOT OLD.type OR
				NEW.group_name IS NOT OLD.group_name
			)
			BEGIN
				UPDATE _emdash_redirects
				SET config_revision = lower(hex(randomblob(16)))
				WHERE id = NEW.id;
			END
		`.execute(db);
	}
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
