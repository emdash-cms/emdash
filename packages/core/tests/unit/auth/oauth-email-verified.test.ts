import type { AuthAdapter, OAuthProfile } from "@emdash-cms/auth";
import { findOrCreateOAuthUser, Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("OAuth sign-in email verification", () => {
	let db: Kysely<Database>;
	let adapter: AuthAdapter;
	let userId: string;

	const profile: OAuthProfile = {
		id: "provider-account-1",
		email: "Owner@Example.com",
		name: "Owner",
		avatarUrl: null,
		emailVerified: true,
	};

	beforeEach(async () => {
		db = await setupTestDatabase();
		adapter = createKyselyAdapter(db);
		const user = await adapter.createUser({
			email: "owner@example.com",
			name: "Owner",
			role: Role.ADMIN,
			emailVerified: false,
		});
		userId = user.id;
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function storedEmailVerified() {
		return (await adapter.getUserById(userId))?.emailVerified;
	}

	it("marks the address verified when linking a provider that verified it", async () => {
		const user = await findOrCreateOAuthUser(adapter, "github", profile);

		expect(user.emailVerified).toBe(true);
		expect(await storedEmailVerified()).toBe(true);
	});

	it("marks the address verified when signing in with an already linked account", async () => {
		await adapter.createOAuthAccount({
			provider: "github",
			providerAccountId: profile.id,
			userId,
		});

		await findOrCreateOAuthUser(adapter, "github", profile);

		expect(await storedEmailVerified()).toBe(true);
	});

	it("leaves the address unverified when the provider has not verified it", async () => {
		await adapter.createOAuthAccount({
			provider: "github",
			providerAccountId: profile.id,
			userId,
		});

		await findOrCreateOAuthUser(adapter, "github", { ...profile, emailVerified: false });

		expect(await storedEmailVerified()).toBe(false);
	});

	it("leaves the address unverified when the provider verified a different address", async () => {
		await adapter.createOAuthAccount({
			provider: "github",
			providerAccountId: profile.id,
			userId,
		});

		await findOrCreateOAuthUser(adapter, "github", { ...profile, email: "other@example.com" });

		expect(await storedEmailVerified()).toBe(false);
	});
});
