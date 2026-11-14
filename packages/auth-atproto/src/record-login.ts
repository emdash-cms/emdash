import type { Kysely } from "kysely";

interface LoginTables {
	users: { id: string; last_login_at: string | null };
}

export async function recordLogin<T>(db: Kysely<T>, userId: string): Promise<void> {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only the user id and optional login column are accessed
	const users = db as unknown as Kysely<LoginTables>;
	const row = await users
		.selectFrom("users")
		.selectAll()
		.where("id", "=", userId)
		.executeTakeFirst();
	// The provider can be upgraded before core adds the login timestamp column.
	if (!row || !Object.hasOwn(row, "last_login_at")) return;
	await users
		.updateTable("users")
		.set({ last_login_at: new Date().toISOString() })
		.where("id", "=", userId)
		.execute();
}
