import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE _emdash_role_defs (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			label TEXT NOT NULL,
			level INTEGER NOT NULL UNIQUE,
			builtin INTEGER NOT NULL DEFAULT 0,
			permissions TEXT,
			fields TEXT,
			color TEXT,
			description TEXT,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT DEFAULT CURRENT_TIMESTAMP
		)
	`.execute(db);

	// Seed the 5 built-in roles
	await sql`
		INSERT INTO _emdash_role_defs (id, name, label, level, builtin, description, color)
		VALUES
			('role_subscriber', 'subscriber', 'Subscriber', 10, 1, 'Can view content', 'gray'),
			('role_contributor', 'contributor', 'Contributor', 20, 1, 'Can create content', 'blue'),
			('role_author', 'author', 'Author', 30, 1, 'Can publish own content', 'green'),
			('role_editor', 'editor', 'Editor', 40, 1, 'Can manage all content', 'purple'),
			('role_admin', 'admin', 'Admin', 50, 1, 'Full access', 'red')
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE IF EXISTS _emdash_role_defs`.execute(db);
}
