import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";

export async function startUserSession(
	db: Kysely<Database>,
	session: { set(key: "user", value: { id: string }): void },
	userId: string,
): Promise<void> {
	await db
		.updateTable("users")
		.set({ last_login_at: new Date().toISOString() })
		.where("id", "=", userId)
		.execute();
	session.set("user", { id: userId });
}
