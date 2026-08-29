import { describe, expect, it, vi } from "vitest";

import { Role } from "../types.js";
import type { AuthAdapter, User } from "../types.js";
import { findOrCreateOAuthUser } from "./consumer.js";
import type { OAuthProfile } from "./types.js";

function makeUser(disabled: boolean): User {
	return {
		id: "user_1",
		email: "user@example.com",
		name: "User",
		avatarUrl: null,
		role: Role.AUTHOR,
		emailVerified: true,
		disabled,
		data: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

const profile: OAuthProfile = {
	id: "provider-account-1",
	email: "user@example.com",
	name: "Provider User",
	avatarUrl: null,
	emailVerified: true,
};

describe("findOrCreateOAuthUser", () => {
	it("rejects an already-linked disabled user", async () => {
		const adapter = {
			getOAuthAccount: vi.fn(async () => ({
				provider: "google",
				providerAccountId: profile.id,
				userId: "user_1",
				createdAt: new Date(),
			})),
			getUserById: vi.fn(async () => makeUser(true)),
		} as unknown as AuthAdapter;

		await expect(findOrCreateOAuthUser(adapter, "google", profile)).rejects.toMatchObject({
			code: "account_disabled",
		});
	});

	it("does not link a verified OAuth identity to a disabled user", async () => {
		const createOAuthAccount = vi.fn();
		const adapter = {
			getOAuthAccount: vi.fn(async () => null),
			getUserByEmail: vi.fn(async () => makeUser(true)),
			createOAuthAccount,
		} as unknown as AuthAdapter;

		await expect(findOrCreateOAuthUser(adapter, "google", profile)).rejects.toMatchObject({
			code: "account_disabled",
		});
		expect(createOAuthAccount).not.toHaveBeenCalled();
	});

	it("returns an enabled linked user", async () => {
		const user = makeUser(false);
		const adapter = {
			getOAuthAccount: vi.fn(async () => ({
				provider: "google",
				providerAccountId: profile.id,
				userId: user.id,
				createdAt: new Date(),
			})),
			getUserById: vi.fn(async () => user),
		} as unknown as AuthAdapter;

		await expect(findOrCreateOAuthUser(adapter, "google", profile)).resolves.toBe(user);
	});
});
