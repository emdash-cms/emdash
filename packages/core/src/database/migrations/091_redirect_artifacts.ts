import { type Kysely, sql } from "kysely";

import { isPostgres } from "../dialect-helpers.js";

/**
 * Published redirect artifacts: compact, content-addressed snapshots of the
 * enabled redirect rules that the middleware loads in one query.
 *
 * `revision` counts changes to the columns enabled rules are published from
 * and is bumped by triggers, so writes that bypass the handlers still mark the
 * published generation stale. Hit tracking does not bump it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	const postgres = isPostgres(db);

	await db.schema
		.createTable("_emdash_redirect_state")
		.ifNotExists()
		.addColumn("id", "integer", (column) => column.primaryKey())
		.addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
		.addColumn("generation", "text")
		.addColumn("generation_revision", "integer", (column) => column.notNull().defaultTo(-1))
		.addColumn("repair_expires_at", postgres ? "bigint" : "integer", (column) =>
			column.notNull().defaultTo(0),
		)
		.execute();
	await sql`
		INSERT INTO _emdash_redirect_state (id, revision, generation, generation_revision, repair_expires_at)
		VALUES (1, 0, NULL, -1, 0)
		ON CONFLICT (id) DO NOTHING
	`.execute(db);

	await db.schema
		.createTable("_emdash_redirect_artifacts")
		.ifNotExists()
		.addColumn("digest", "text", (column) => column.primaryKey())
		.addColumn("kind", "text", (column) => column.notNull())
		.addColumn("payload", "text", (column) => column.notNull())
		.execute();

	await db.schema
		.createTable("_emdash_redirect_generation_artifacts")
		.ifNotExists()
		.addColumn("generation", "text", (column) => column.notNull())
		.addColumn("position", "integer", (column) => column.notNull())
		.addColumn("digest", "text", (column) => column.notNull())
		.addPrimaryKeyConstraint("pk_emdash_redirect_generation_artifacts", ["generation", "position"])
		.execute();
	await db.schema
		.createIndex("idx_emdash_redirect_generation_artifacts_digest")
		.ifNotExists()
		.on("_emdash_redirect_generation_artifacts")
		.column("digest")
		.execute();

	if (postgres) {
		await sql`
			CREATE OR REPLACE FUNCTION emdash_redirect_bump_revision()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				UPDATE _emdash_redirect_state SET revision = revision + 1 WHERE id = 1;
				RETURN NULL;
			END;
			$$
		`.execute(db);
		await sql`DROP TRIGGER IF EXISTS emdash_redirect_state_revision_insert ON _emdash_redirects`.execute(
			db,
		);
		await sql`
			CREATE TRIGGER emdash_redirect_state_revision_insert
			AFTER INSERT ON _emdash_redirects
			FOR EACH ROW
			WHEN (NEW.enabled = 1)
			EXECUTE FUNCTION emdash_redirect_bump_revision()
		`.execute(db);
		await sql`DROP TRIGGER IF EXISTS emdash_redirect_state_revision_delete ON _emdash_redirects`.execute(
			db,
		);
		await sql`
			CREATE TRIGGER emdash_redirect_state_revision_delete
			AFTER DELETE ON _emdash_redirects
			FOR EACH ROW
			WHEN (OLD.enabled = 1)
			EXECUTE FUNCTION emdash_redirect_bump_revision()
		`.execute(db);
		await sql`DROP TRIGGER IF EXISTS emdash_redirect_state_revision_update ON _emdash_redirects`.execute(
			db,
		);
		await sql`
			CREATE TRIGGER emdash_redirect_state_revision_update
			AFTER UPDATE OF source, destination, enabled, is_pattern, type, created_at ON _emdash_redirects
			FOR EACH ROW
			WHEN ((NEW.enabled = 1 OR OLD.enabled = 1) AND (
				NEW.source IS DISTINCT FROM OLD.source OR
				NEW.destination IS DISTINCT FROM OLD.destination OR
				NEW.enabled IS DISTINCT FROM OLD.enabled OR
				NEW.is_pattern IS DISTINCT FROM OLD.is_pattern OR
				NEW.type IS DISTINCT FROM OLD.type OR
				NEW.created_at IS DISTINCT FROM OLD.created_at
			))
			EXECUTE FUNCTION emdash_redirect_bump_revision()
		`.execute(db);
		return;
	}

	await sql`
		CREATE TRIGGER IF NOT EXISTS emdash_redirect_state_revision_insert
		AFTER INSERT ON _emdash_redirects
		WHEN NEW.enabled = 1
		BEGIN
			UPDATE _emdash_redirect_state SET revision = revision + 1 WHERE id = 1;
		END
	`.execute(db);
	await sql`
		CREATE TRIGGER IF NOT EXISTS emdash_redirect_state_revision_delete
		AFTER DELETE ON _emdash_redirects
		WHEN OLD.enabled = 1
		BEGIN
			UPDATE _emdash_redirect_state SET revision = revision + 1 WHERE id = 1;
		END
	`.execute(db);
	await sql`
		CREATE TRIGGER IF NOT EXISTS emdash_redirect_state_revision_update
		AFTER UPDATE OF source, destination, enabled, is_pattern, type, created_at ON _emdash_redirects
		WHEN (NEW.enabled = 1 OR OLD.enabled = 1) AND (
			NEW.source IS NOT OLD.source OR
			NEW.destination IS NOT OLD.destination OR
			NEW.enabled IS NOT OLD.enabled OR
			NEW.is_pattern IS NOT OLD.is_pattern OR
			NEW.type IS NOT OLD.type OR
			NEW.created_at IS NOT OLD.created_at
		)
		BEGIN
			UPDATE _emdash_redirect_state SET revision = revision + 1 WHERE id = 1;
		END
	`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
