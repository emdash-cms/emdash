import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserRepository } from "../../../src/database/repositories/user.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("Kysely auth timestamps", () => {
	let db: Kysely<Database>;
	let originalTimezone: string | undefined;

	beforeEach(async () => {
		originalTimezone = process.env.TZ;
		process.env.TZ = "America/New_York";
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		if (originalTimezone === undefined) {
			delete process.env.TZ;
		} else {
			process.env.TZ = originalTimezone;
		}
		await teardownTestDatabase(db);
	});

	it("treats timezone-less SQLite user timestamps as UTC", async () => {
		const created = await new UserRepository(db).create({
			email: "timestamp@example.com",
			role: 50,
		});
		const row = await db
			.selectFrom("users")
			.select(["created_at", "updated_at"])
			.where("id", "=", created.id)
			.executeTakeFirstOrThrow();

		const user = await createKyselyAdapter(db).getUserById(created.id);

		expect(user?.createdAt.toISOString()).toBe(
			new Date(`${row.created_at.replace(" ", "T")}Z`).toISOString(),
		);
		expect(user?.updatedAt.toISOString()).toBe(
			new Date(`${row.updated_at.replace(" ", "T")}Z`).toISOString(),
		);
	});
});
