import { AccountDisabledError } from "@emdash-cms/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findOrCreateOAuthUser: vi.fn(),
	getAtprotoOAuthClient: vi.fn(),
	resolveAtprotoProfile: vi.fn(),
}));

vi.mock("@emdash-cms/auth", async (importOriginal) => ({
	...(await importOriginal<typeof import("@emdash-cms/auth")>()),
	findOrCreateOAuthUser: mocks.findOrCreateOAuthUser,
}));

vi.mock("@emdash-cms/auth-atproto/oauth-client", () => ({
	getAtprotoOAuthClient: mocks.getAtprotoOAuthClient,
	resolveAtprotoProfile: mocks.resolveAtprotoProfile,
}));

vi.mock("../src/storage.js", () => ({
	getAtprotoStorage: vi.fn().mockResolvedValue({}),
}));

vi.mock("emdash/api/route-utils", () => ({
	finalizeSetup: vi.fn(),
	getPublicOrigin: vi.fn().mockReturnValue("https://example.com"),
	OptionsRepository: class {
		get() {
			return true;
		}
	},
}));

import { GET } from "../src/routes/callback.js";

describe("AT Protocol callback", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("removes the provider session when the EmDash account is disabled", async () => {
		const signOut = vi.fn().mockResolvedValue(undefined);
		mocks.getAtprotoOAuthClient.mockResolvedValue({
			callback: vi.fn().mockResolvedValue({
				session: { did: "did:plc:disabled", signOut },
			}),
		});
		mocks.resolveAtprotoProfile.mockResolvedValue({
			displayName: "Disabled User",
			handle: "disabled.example.com",
		});
		mocks.findOrCreateOAuthUser.mockRejectedValue(new AccountDisabledError());

		const session = { set: vi.fn() };
		const redirect = vi.fn((location: string) =>
			Response.redirect(new URL(location, "https://example.com")),
		);
		const response = await GET({
			request: new Request("https://example.com/_emdash/api/auth/atproto/callback?code=abc"),
			locals: {
				emdash: {
					db: {},
					config: {
						authProviders: [
							{
								id: "atproto",
								config: { allowedDIDs: ["did:plc:disabled"] },
							},
						],
					},
				},
			},
			session,
			redirect,
		} as never);

		expect(signOut).toHaveBeenCalledOnce();
		expect(session.set).not.toHaveBeenCalled();
		expect(response.headers.get("location")).toContain("error=account_disabled");
	});
});
