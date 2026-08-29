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
		// A non-UTC zone makes regressions to local parsing of SQLite UTC timestamps observable.
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

	it.each([
		{
			label: "timezone-less seconds",
			stored: "2026-08-29 10:11:12",
			expected: "2026-08-29T10:11:12.000Z",
		},
		{
			label: "timezone-less fractional seconds",
			stored: "2026-08-29 10:11:12.123",
			expected: "2026-08-29T10:11:12.123Z",
		},
		{
			label: "a Z designator",
			stored: "2026-08-29T10:11:12Z",
			expected: "2026-08-29T10:11:12.000Z",
		},
		{
			label: "an explicit offset",
			stored: "2026-08-29T19:11:12+09:00",
			expected: "2026-08-29T10:11:12.000Z",
		},
	])("converts a user timestamp with $label", async ({ stored, expected }) => {
		const created = await new UserRepository(db).create({
			email: "timestamp@example.com",
			role: 50,
		});
		await db
			.updateTable("users")
			.set({ created_at: stored, updated_at: stored })
			.where("id", "=", created.id)
			.execute();

		const user = await createKyselyAdapter(db).getUserById(created.id);

		if (stored === "2026-08-29 10:11:12") {
			const incorrectlyParsedAsLocal = new Date(stored).getTime();
			expect(incorrectlyParsedAsLocal).not.toBe(Date.parse(expected));
		}
		expect(user?.createdAt.toISOString()).toBe(expected);
		expect(user?.updatedAt.toISOString()).toBe(expected);
	});

	it("converts timestamps from related auth tables", async () => {
		const created = await new UserRepository(db).create({
			email: "related-timestamps@example.com",
			role: 50,
		});
		await db
			.insertInto("credentials")
			.values({
				id: "credential-1",
				user_id: created.id,
				public_key: new Uint8Array([1, 2, 3]),
				algorithm: -7,
				counter: 0,
				device_type: "singleDevice",
				backed_up: 0,
				transports: null,
				name: null,
				created_at: "2026-08-29 10:11:12.123",
				last_used_at: "2026-08-29T19:11:12+09:00",
			})
			.execute();
		await db
			.insertInto("auth_tokens")
			.values({
				hash: "token-1",
				user_id: created.id,
				email: null,
				type: "invite",
				role: null,
				invited_by: null,
				expires_at: "2026-08-29 10:11:12",
				created_at: "2026-08-29T10:11:12Z",
			})
			.execute();
		await db
			.insertInto("oauth_accounts")
			.values({
				provider: "example",
				provider_account_id: "account-1",
				user_id: created.id,
				created_at: "2026-08-29T19:11:12+09:00",
			})
			.execute();
		await db
			.insertInto("allowed_domains")
			.values({
				domain: "example.com",
				default_role: 20,
				enabled: 1,
				created_at: "2026-08-29 10:11:12",
			})
			.execute();

		const adapter = createKyselyAdapter(db);
		const [credential, token, oauthAccount, allowedDomain] = await Promise.all([
			adapter.getCredentialById("credential-1"),
			adapter.getToken("token-1", "invite"),
			adapter.getOAuthAccount("example", "account-1"),
			adapter.getAllowedDomain("example.com"),
		]);

		expect(credential?.createdAt.toISOString()).toBe("2026-08-29T10:11:12.123Z");
		expect(credential?.lastUsedAt.toISOString()).toBe("2026-08-29T10:11:12.000Z");
		expect(token?.createdAt.toISOString()).toBe("2026-08-29T10:11:12.000Z");
		expect(token?.expiresAt.toISOString()).toBe("2026-08-29T10:11:12.000Z");
		expect(oauthAccount?.createdAt.toISOString()).toBe("2026-08-29T10:11:12.000Z");
		expect(allowedDomain?.createdAt.toISOString()).toBe("2026-08-29T10:11:12.000Z");
	});

	it("preserves a null last login", async () => {
		const created = await new UserRepository(db).create({
			email: "no-login@example.com",
			role: 50,
		});

		const result = await createKyselyAdapter(db).getUsers();

		expect(result.items.find((user) => user.id === created.id)?.lastLogin).toBeNull();
	});

	it("rejects an invalid database timestamp", async () => {
		const created = await new UserRepository(db).create({
			email: "invalid-timestamp@example.com",
			role: 50,
		});
		await db
			.updateTable("users")
			.set({ created_at: "not-a-timestamp" })
			.where("id", "=", created.id)
			.execute();

		await expect(createKyselyAdapter(db).getUserById(created.id)).rejects.toThrow(
			"Invalid database timestamp",
		);
	});
});
