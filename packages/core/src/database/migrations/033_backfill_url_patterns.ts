import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * Migration: Backfill default URL patterns for posts and pages
 *
 * Existing sites created before URL patterns were added to the default seed
 * have NULL url_pattern on their posts and pages collections. This migration
 * sets sensible defaults so resolveEmDashPath works out of the box.
 *
 * Only updates rows where url_pattern IS NULL -- user-configured patterns
 * are left untouched.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		UPDATE _emdash_collections
		SET url_pattern = '/posts/{slug}'
		WHERE slug = 'posts' AND url_pattern IS NULL
	`.execute(db);

	await sql`
		UPDATE _emdash_collections
		SET url_pattern = '/{slug}'
		WHERE slug = 'pages' AND url_pattern IS NULL
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// Reverting to NULL is safe -- it restores the pre-migration state.
	// We can't distinguish "was NULL before" from "user set it to this exact value",
	// but the values we set are the obvious defaults, so clearing them is reasonable.
	await sql`
		UPDATE _emdash_collections
		SET url_pattern = NULL
		WHERE slug = 'posts' AND url_pattern = '/posts/{slug}'
	`.execute(db);

	await sql`
		UPDATE _emdash_collections
		SET url_pattern = NULL
		WHERE slug = 'pages' AND url_pattern = '/{slug}'
	`.execute(db);
}
