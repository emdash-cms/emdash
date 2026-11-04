import { type Kysely, sql } from "kysely";

import { isPostgres } from "../dialect-helpers.js";

/**
 * Rejects enabling a disabled redirect when its edge would close a loop.
 * The loop guards from 081 only fire when source or destination changes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	if (isPostgres(db)) {
		await sql`
			CREATE OR REPLACE FUNCTION emdash_redirect_validate_enable()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				PERFORM pg_advisory_xact_lock(1168624763);
				IF EXISTS (
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
				) THEN
					RAISE EXCEPTION 'redirect loop';
				END IF;
				RETURN NEW;
			END;
			$$
		`.execute(db);
		await sql`DROP TRIGGER IF EXISTS emdash_redirect_loop_enable ON _emdash_redirects`.execute(db);
		await sql`
			CREATE TRIGGER emdash_redirect_loop_enable
			BEFORE UPDATE OF enabled ON _emdash_redirects
			FOR EACH ROW
			WHEN (NEW.enabled = 1 AND OLD.enabled IS DISTINCT FROM 1 AND NEW.destination <> '')
			EXECUTE FUNCTION emdash_redirect_validate_enable()
		`.execute(db);
		return;
	}

	// No `CASE ... END;` inside trigger bodies: the D1 HTTP API used by
	// `emdash migrate` ends the statement at an inner `END;`.
	await sql`
		CREATE TRIGGER IF NOT EXISTS emdash_redirect_loop_enable
		BEFORE UPDATE OF enabled ON _emdash_redirects
		WHEN NEW.enabled = 1 AND OLD.enabled IS NOT 1 AND NEW.destination <> ''
		BEGIN
			SELECT RAISE(ABORT, 'redirect loop') WHERE EXISTS (
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
			);
		END
	`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
