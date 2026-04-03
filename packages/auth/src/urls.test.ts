import { describe, expect, it } from "vitest";

import { createInviteToken } from "./invite.js";
import { sendMagicLink } from "./magic-link/index.js";
import { createAuthorizationUrl } from "./oauth/consumer.js";
import { requestSignup } from "./signup.js";
import { Role, type AuthAdapter, type EmailMessage } from "./types.js";

function createAdapter(overrides: Partial<AuthAdapter> = {}): AuthAdapter {
	return {
		getUserById: async () => null,
		getUserByEmail: async () => null,
		createUser: async () => {
			throw new Error("Not implemented");
		},
		updateUser: async () => {},
		deleteUser: async () => {},
		countUsers: async () => 0,
		getUsers: async () => ({ items: [] }),
		getUserWithDetails: async () => null,
		countAdmins: async () => 0,
		getCredentialById: async () => null,
		getCredentialsByUserId: async () => [],
		createCredential: async () => {
			throw new Error("Not implemented");
		},
		updateCredentialCounter: async () => {},
		updateCredentialName: async () => {},
		deleteCredential: async () => {},
		countCredentialsByUserId: async () => 0,
		createToken: async () => {},
		getToken: async () => null,
		deleteToken: async () => {},
		deleteExpiredTokens: async () => {},
		getOAuthAccount: async () => null,
		getOAuthAccountsByUserId: async () => [],
		createOAuthAccount: async () => {
			throw new Error("Not implemented");
		},
		deleteOAuthAccount: async () => {},
		getAllowedDomain: async () => null,
		getAllowedDomains: async () => [],
		createAllowedDomain: async () => {
			throw new Error("Not implemented");
		},
		updateAllowedDomain: async () => {},
		deleteAllowedDomain: async () => {},
		...overrides,
	};
}

describe("auth URL generation", () => {
	const baseUrl = "https://example.com/_emdash";

	it("preserves a subpath when building invite URLs", async () => {
		const result = await createInviteToken(
			{ baseUrl },
			createAdapter(),
			"invitee@example.com",
			Role.EDITOR,
			"admin-user",
		);

		expect(result.url).toMatch(
			/^https:\/\/example\.com\/_emdash\/api\/auth\/invite\/accept\?token=/,
		);
	});

	it("preserves a subpath when building magic link URLs", async () => {
		const sentMessages: EmailMessage[] = [];
		const adapter = createAdapter({
			getUserByEmail: async (email) => ({
				id: "user-1",
				email,
				name: null,
				avatarUrl: null,
				role: Role.EDITOR,
				emailVerified: true,
				disabled: false,
				data: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			}),
		});

		await sendMagicLink(
			{
				baseUrl,
				siteName: "Example",
				email: async (message) => {
					sentMessages.push(message);
				},
			},
			adapter,
			"user@example.com",
		);

		expect(sentMessages[0]?.text).toContain(
			"https://example.com/_emdash/api/auth/magic-link/verify?token=",
		);
	});

	it("preserves a subpath when building signup verification URLs", async () => {
		const sentMessages: EmailMessage[] = [];
		const adapter = createAdapter({
			getAllowedDomain: async () => ({
				domain: "example.com",
				defaultRole: Role.CONTRIBUTOR,
				enabled: true,
				createdAt: new Date(),
			}),
		});

		await requestSignup(
			{
				baseUrl,
				siteName: "Example",
				email: async (message) => {
					sentMessages.push(message);
				},
			},
			adapter,
			"user@example.com",
		);

		expect(sentMessages[0]?.text).toContain(
			"https://example.com/_emdash/api/auth/signup/verify?token=",
		);
	});

	it("preserves a subpath when building OAuth callback URLs", async () => {
		const stateStore = {
			set: async () => {},
			get: async () => null,
			delete: async () => {},
		};

		const result = await createAuthorizationUrl(
			{
				baseUrl,
				providers: {
					github: {
						clientId: "client-id",
						clientSecret: "client-secret",
					},
				},
			},
			"github",
			stateStore,
		);

		expect(result.url).toContain(
			encodeURIComponent("https://example.com/_emdash/api/auth/oauth/github/callback"),
		);
	});
});
