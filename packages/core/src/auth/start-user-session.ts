import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";

/**
 * Sign a user in on the request's Astro session, under a new session id.
 *
 * `session.set()` alone keeps the id named by the request's session cookie
 * whenever that id is live in the store, so whoever already holds that id
 * would share the signed-in session. `regenerate()` issues a new id and
 * removes the old one from the store.
 */
export async function startUserSession(
	db: Kysely<Database>,
	session: { regenerate(): Promise<void>; set(key: "user", value: { id: string }): void },
	userId: string,
): Promise<void> {
	await db
		.updateTable("users")
		.set({ last_login_at: new Date().toISOString() })
		.where("id", "=", userId)
		.execute();
	await session.regenerate();
	session.set("user", { id: userId });
}
