import { type Kysely, sql } from "kysely";

const ADMIN_ROLE = 50;

/**
 * Marks the site owner's address verified on sites set up before passkey
 * setup stored it verified. The owner is the first user ever created, if it
 * has a passkey and no linked provider account. Owners created through
 * a provider keep the provider's verdict, and AT Protocol placeholder
 * addresses are never verified.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		UPDATE users SET email_verified = 1
		WHERE id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1)
			AND role >= ${ADMIN_ROLE}
			AND email_verified = 0
			AND email NOT LIKE ${"%@atproto.invalid"}
			AND EXISTS (SELECT 1 FROM credentials WHERE credentials.user_id = users.id)
			AND NOT EXISTS (SELECT 1 FROM oauth_accounts WHERE oauth_accounts.user_id = users.id)
	`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
