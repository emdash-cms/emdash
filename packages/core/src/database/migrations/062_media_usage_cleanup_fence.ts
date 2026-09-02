import { sql, type Kysely } from "kysely";

import { columnExists, currentTimestamp, isPostgres } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "_emdash_media_usage", "cleanup_lease_token"))) {
		await db.schema
			.alterTable("_emdash_media_usage")
			.addColumn("cleanup_lease_token", "text")
			.execute();
	}
	await db.schema
		.createTable("_emdash_media_usage_cleanup_fence")
		.ifNotExists()
		.addColumn("task_key", "text", (c) => c.primaryKey())
		.addColumn("generation_floor", "text", (c) => c.notNull())
		.addColumn("updated_at", "text", (c) => c.notNull().defaultTo(currentTimestamp(db)))
		.execute();

	if (isPostgres(db)) {
		await sql
			.raw("DROP TRIGGER IF EXISTS emdash_media_usage_record_cleanup_fence ON _emdash_media_usage")
			.execute(db);
		await sql
			.raw(
				"DROP TRIGGER IF EXISTS emdash_media_usage_fence_source_generation_update ON _emdash_media_usage_sources",
			)
			.execute(db);
		await sql
			.raw(
				"DROP TRIGGER IF EXISTS emdash_media_usage_fence_source_generation_insert ON _emdash_media_usage_sources",
			)
			.execute(db);
		await sql
			.raw(
				"DROP TRIGGER IF EXISTS emdash_media_usage_lock_cleanup_update ON _emdash_media_usage_sources",
			)
			.execute(db);
		await sql
			.raw(
				"DROP TRIGGER IF EXISTS emdash_media_usage_lock_cleanup_insert ON _emdash_media_usage_sources",
			)
			.execute(db);
		await sql
			.raw(
				"DROP TRIGGER IF EXISTS emdash_media_usage_lock_cleanup_delete ON _emdash_media_usage_sources",
			)
			.execute(db);
		await sql
			.raw(`
			CREATE OR REPLACE FUNCTION emdash_media_usage_lock_cleanup()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				PERFORM 1
				FROM _emdash_media_usage_cleanup AS cleanup
				WHERE cleanup.task_key = 'projection_gc'
				FOR SHARE;
				RETURN NULL;
			END;
			$$
		`)
			.execute(db);
		await sql
			.raw(`
			CREATE OR REPLACE FUNCTION emdash_media_usage_fence_source_generation()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				IF EXISTS (
					SELECT 1
					FROM _emdash_media_usage_cleanup_fence AS fence
					WHERE fence.task_key = 'projection_gc'
						AND NEW.current_generation <= fence.generation_floor
				) AND NOT EXISTS (
					SELECT 1
					FROM _emdash_media_usage_generation_writes AS writer
					WHERE writer.source_key = NEW.source_key
						AND writer.generation = NEW.current_generation
						AND writer.expires_at::timestamptz > clock_timestamp()
				) THEN
					RETURN NULL;
				END IF;
				RETURN NEW;
			END;
			$$
		`)
			.execute(db);
		await sql
			.raw(`
			CREATE TRIGGER emdash_media_usage_lock_cleanup_insert
			BEFORE INSERT ON _emdash_media_usage_sources
			FOR EACH STATEMENT
			EXECUTE FUNCTION emdash_media_usage_lock_cleanup()
		`)
			.execute(db);
		await sql
			.raw(`
			CREATE TRIGGER emdash_media_usage_lock_cleanup_update
			BEFORE UPDATE OF current_generation ON _emdash_media_usage_sources
			FOR EACH STATEMENT
			EXECUTE FUNCTION emdash_media_usage_lock_cleanup()
		`)
			.execute(db);
		await sql
			.raw(`
			CREATE TRIGGER emdash_media_usage_lock_cleanup_delete
			BEFORE DELETE ON _emdash_media_usage_sources
			FOR EACH STATEMENT
			EXECUTE FUNCTION emdash_media_usage_lock_cleanup()
		`)
			.execute(db);
		await sql
			.raw(`
			CREATE OR REPLACE FUNCTION emdash_media_usage_record_cleanup_fence()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				IF OLD.cleanup_lease_token IS NOT NULL AND EXISTS (
					SELECT 1
					FROM _emdash_media_usage_cleanup AS cleanup
					WHERE cleanup.task_key = 'projection_gc'
						AND cleanup.lease_token = OLD.cleanup_lease_token
				) THEN
					INSERT INTO _emdash_media_usage_cleanup_fence (
						task_key,
						generation_floor,
						updated_at
					)
					VALUES ('projection_gc', OLD.generation, CURRENT_TIMESTAMP::text)
					ON CONFLICT (task_key) DO UPDATE SET
						generation_floor = CASE
							WHEN EXCLUDED.generation_floor > _emdash_media_usage_cleanup_fence.generation_floor
							THEN EXCLUDED.generation_floor
							ELSE _emdash_media_usage_cleanup_fence.generation_floor
						END,
						updated_at = EXCLUDED.updated_at;
				END IF;
				RETURN OLD;
			END;
			$$
		`)
			.execute(db);
		await sql
			.raw(`
			CREATE TRIGGER emdash_media_usage_fence_source_generation_insert
			BEFORE INSERT ON _emdash_media_usage_sources
			FOR EACH ROW
			EXECUTE FUNCTION emdash_media_usage_fence_source_generation()
		`)
			.execute(db);
		await sql
			.raw(`
			CREATE TRIGGER emdash_media_usage_fence_source_generation_update
			BEFORE UPDATE OF current_generation ON _emdash_media_usage_sources
			FOR EACH ROW
			EXECUTE FUNCTION emdash_media_usage_fence_source_generation()
		`)
			.execute(db);
		await sql
			.raw(`
			CREATE TRIGGER emdash_media_usage_record_cleanup_fence
			BEFORE DELETE ON _emdash_media_usage
			FOR EACH ROW
			WHEN (OLD.cleanup_lease_token IS NOT NULL)
			EXECUTE FUNCTION emdash_media_usage_record_cleanup_fence()
		`)
			.execute(db);
		return;
	}

	await sql
		.raw(`
		CREATE TRIGGER IF NOT EXISTS emdash_media_usage_fence_source_generation_insert
		BEFORE INSERT ON _emdash_media_usage_sources
		WHEN EXISTS (
			SELECT 1
			FROM _emdash_media_usage_cleanup_fence AS fence
			WHERE fence.task_key = 'projection_gc'
				AND NEW.current_generation <= fence.generation_floor
		) AND NOT EXISTS (
			SELECT 1
			FROM _emdash_media_usage_generation_writes AS writer
			WHERE writer.source_key = NEW.source_key
				AND writer.generation = NEW.current_generation
				AND writer.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		)
		BEGIN
			SELECT RAISE(IGNORE);
		END
	`)
		.execute(db);
	await sql
		.raw(`
		CREATE TRIGGER IF NOT EXISTS emdash_media_usage_fence_source_generation_update
		BEFORE UPDATE OF current_generation ON _emdash_media_usage_sources
		WHEN NEW.current_generation <> OLD.current_generation
			AND EXISTS (
				SELECT 1
				FROM _emdash_media_usage_cleanup_fence AS fence
				WHERE fence.task_key = 'projection_gc'
					AND NEW.current_generation <= fence.generation_floor
			) AND NOT EXISTS (
				SELECT 1
				FROM _emdash_media_usage_generation_writes AS writer
				WHERE writer.source_key = NEW.source_key
					AND writer.generation = NEW.current_generation
					AND writer.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			)
		BEGIN
			SELECT RAISE(IGNORE);
		END
	`)
		.execute(db);
	await sql
		.raw(`
		CREATE TRIGGER IF NOT EXISTS emdash_media_usage_record_cleanup_fence
		BEFORE DELETE ON _emdash_media_usage
		WHEN OLD.cleanup_lease_token IS NOT NULL AND EXISTS (
			SELECT 1
			FROM _emdash_media_usage_cleanup AS cleanup
			WHERE cleanup.task_key = 'projection_gc'
				AND cleanup.lease_token = OLD.cleanup_lease_token
		)
		BEGIN
			INSERT INTO _emdash_media_usage_cleanup_fence (
				task_key,
				generation_floor,
				updated_at
			)
			VALUES ('projection_gc', OLD.generation, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
			ON CONFLICT (task_key) DO UPDATE SET
				generation_floor = CASE
					WHEN excluded.generation_floor > _emdash_media_usage_cleanup_fence.generation_floor
					THEN excluded.generation_floor
					ELSE _emdash_media_usage_cleanup_fence.generation_floor
				END,
				updated_at = excluded.updated_at;
		END
	`)
		.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (isPostgres(db)) {
		await sql
			.raw("DROP TRIGGER IF EXISTS emdash_media_usage_record_cleanup_fence ON _emdash_media_usage")
			.execute(db);
		await sql
			.raw(
				"DROP TRIGGER IF EXISTS emdash_media_usage_fence_source_generation_update ON _emdash_media_usage_sources",
			)
			.execute(db);
		await sql
			.raw(
				"DROP TRIGGER IF EXISTS emdash_media_usage_fence_source_generation_insert ON _emdash_media_usage_sources",
			)
			.execute(db);
		await sql
			.raw(
				"DROP TRIGGER IF EXISTS emdash_media_usage_lock_cleanup_update ON _emdash_media_usage_sources",
			)
			.execute(db);
		await sql
			.raw(
				"DROP TRIGGER IF EXISTS emdash_media_usage_lock_cleanup_insert ON _emdash_media_usage_sources",
			)
			.execute(db);
		await sql
			.raw(
				"DROP TRIGGER IF EXISTS emdash_media_usage_lock_cleanup_delete ON _emdash_media_usage_sources",
			)
			.execute(db);
		await sql.raw("DROP FUNCTION IF EXISTS emdash_media_usage_record_cleanup_fence()").execute(db);
		await sql
			.raw("DROP FUNCTION IF EXISTS emdash_media_usage_fence_source_generation()")
			.execute(db);
		await sql.raw("DROP FUNCTION IF EXISTS emdash_media_usage_lock_cleanup()").execute(db);
	} else {
		await sql.raw("DROP TRIGGER IF EXISTS emdash_media_usage_record_cleanup_fence").execute(db);
		await sql
			.raw("DROP TRIGGER IF EXISTS emdash_media_usage_fence_source_generation_update")
			.execute(db);
		await sql
			.raw("DROP TRIGGER IF EXISTS emdash_media_usage_fence_source_generation_insert")
			.execute(db);
	}
	await db.schema.dropTable("_emdash_media_usage_cleanup_fence").ifExists().execute();
	if (await columnExists(db, "_emdash_media_usage", "cleanup_lease_token")) {
		await db.schema.alterTable("_emdash_media_usage").dropColumn("cleanup_lease_token").execute();
	}
}
