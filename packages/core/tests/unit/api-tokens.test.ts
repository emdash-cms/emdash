import type { Kysely } from "kysely";
import { ulid } from "ulidx";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	deleteApiTokensByName,
	handleApiTokenCreate,
	handleApiTokenList,
} from "../../src/api/handlers/api-tokens.js";
import type { Database } from "../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";

describe("api tokens", () => {
	let db: Kysely<Database>;
	let userId: string;

	beforeEach(async () => {
		db = await setupTestDatabase();
		userId = ulid();
		const now = new Date().toISOString();
		// Tokens reference users (FK), so create one first.
		await db
			.insertInto("users")
			.values({
				id: userId,
				email: "dev@example.com",
				name: "Dev",
				avatar_url: null,
				role: 50,
				email_verified: 1,
				disabled: 0,
				data: null,
				created_at: now,
				updated_at: now,
			})
			.execute();
	});
	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("deleteApiTokensByName removes only the matching name for that user", async () => {
		await handleApiTokenCreate(db, userId, { name: "dev-bypass-token", scopes: ["admin"] });
		await handleApiTokenCreate(db, userId, { name: "dev-bypass-token", scopes: ["admin"] });
		await handleApiTokenCreate(db, userId, { name: "keepme", scopes: ["admin"] });

		const removed = await deleteApiTokensByName(db, userId, "dev-bypass-token");
		expect(removed).toBe(2);

		const list = await handleApiTokenList(db, userId);
		expect(list.success).toBe(true);
		if (list.success) {
			expect(list.data.items.map((t) => t.name)).toEqual(["keepme"]);
		}
	});

	it("re-issuing the dev-bypass token leaves exactly one row (idempotent by name)", async () => {
		// The dev-bypass `?token=1` path drops the prior token before minting a
		// fresh one. Running it twice (e.g. across a reset) must not accumulate.
		for (let i = 0; i < 2; i++) {
			await deleteApiTokensByName(db, userId, "dev-bypass-token");
			const res = await handleApiTokenCreate(db, userId, {
				name: "dev-bypass-token",
				scopes: ["admin"],
			});
			expect(res.success).toBe(true);
		}

		const list = await handleApiTokenList(db, userId);
		expect(list.success).toBe(true);
		if (list.success) {
			const devTokens = list.data.items.filter((t) => t.name === "dev-bypass-token");
			expect(devTokens).toHaveLength(1);
		}
	});
});
