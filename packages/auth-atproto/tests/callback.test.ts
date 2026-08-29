import { AccountDisabledError } from "@emdash-cms/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findOrCreateOAuthUser: vi.fn(),
	getAtprotoOAuthClient: vi.fn(),
	getAtprotoStorage: vi.fn(),
	resolveAtprotoProfile: vi.fn(),
	deleteProviderSession: vi.fn(),
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
	getAtprotoStorage: mocks.getAtprotoStorage,
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
		mocks.deleteProviderSession.mockResolvedValue(true);
		mocks.getAtprotoStorage.mockResolvedValue({
			sessions: { delete: mocks.deleteProviderSession },
		});
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

	it("removes the provider session when the DID is not allowed", async () => {
		const signOut = vi.fn().mockResolvedValue(undefined);
		mocks.getAtprotoOAuthClient.mockResolvedValue({
			callback: vi.fn().mockResolvedValue({
				session: { did: "did:plc:denied", signOut },
			}),
		});
		mocks.resolveAtprotoProfile.mockResolvedValue({
			displayName: "Denied User",
			handle: "denied.example.com",
		});
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
								config: { allowedDIDs: ["did:plc:allowed"] },
							},
						],
					},
				},
			},
			redirect,
		} as never);

		expect(response.headers.get("location")).toContain("error=not_allowed");
		expect(signOut).toHaveBeenCalledOnce();
	});

	it("removes the provider session when profile resolution fails", async () => {
		const signOut = vi.fn().mockResolvedValue(undefined);
		mocks.getAtprotoOAuthClient.mockResolvedValue({
			callback: vi.fn().mockResolvedValue({
				session: { did: "did:plc:error", signOut },
			}),
		});
		mocks.resolveAtprotoProfile.mockRejectedValue(new Error("Profile lookup failed"));
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const redirect = vi.fn((location: string) =>
			Response.redirect(new URL(location, "https://example.com")),
		);

		try {
			const response = await GET({
				request: new Request("https://example.com/_emdash/api/auth/atproto/callback?code=abc"),
				locals: { emdash: { db: {}, config: {} } },
				redirect,
			} as never);

			expect(response.headers.get("location")).toContain("error=atproto_error");
			expect(signOut).toHaveBeenCalledOnce();
		} finally {
			consoleError.mockRestore();
		}
	});

	it("keeps the provider session after authentication succeeds", async () => {
		const signOut = vi.fn().mockResolvedValue(undefined);
		mocks.getAtprotoOAuthClient.mockResolvedValue({
			callback: vi.fn().mockResolvedValue({
				session: { did: "did:plc:allowed", signOut },
			}),
		});
		mocks.resolveAtprotoProfile.mockResolvedValue({
			displayName: "Allowed User",
			handle: "allowed.example.com",
		});
		mocks.findOrCreateOAuthUser.mockResolvedValue({
			id: "user-1",
			email: "user@example.com",
			name: "Allowed User",
			role: 10,
			disabled: false,
		});
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
								config: { allowedDIDs: ["did:plc:allowed"] },
							},
						],
					},
				},
			},
			session,
			redirect,
		} as never);

		expect(response.headers.get("location")).toBe("https://example.com/_emdash/admin");
		expect(session.set).toHaveBeenCalledWith("user", { id: "user-1" });
		expect(signOut).not.toHaveBeenCalled();
		expect(mocks.deleteProviderSession).not.toHaveBeenCalled();
	});

	it("removes local provider credentials without waiting for remote sign-out", async () => {
		const signOut = vi.fn(() => new Promise<void>(() => {}));
		mocks.getAtprotoOAuthClient.mockResolvedValue({
			callback: vi.fn().mockResolvedValue({
				session: { did: "did:plc:denied", signOut },
			}),
		});
		mocks.resolveAtprotoProfile.mockResolvedValue({
			displayName: "Denied User",
			handle: "denied.example.com",
		});
		const redirect = vi.fn((location: string) =>
			Response.redirect(new URL(location, "https://example.com")),
		);

		const result = await Promise.race([
			GET({
				request: new Request("https://example.com/_emdash/api/auth/atproto/callback?code=abc"),
				locals: {
					emdash: {
						db: {},
						config: {
							authProviders: [
								{
									id: "atproto",
									config: { allowedDIDs: ["did:plc:allowed"] },
								},
							],
						},
					},
				},
				redirect,
			} as never),
			new Promise<"timeout">((resolve) => setTimeout(resolve, 50, "timeout")),
		]);

		expect(result).not.toBe("timeout");
		expect(signOut).toHaveBeenCalledOnce();
		expect(mocks.deleteProviderSession).toHaveBeenCalledWith("did:plc:denied");
	});

	it("rejects authentication when the Astro session is unavailable", async () => {
		const signOut = vi.fn().mockResolvedValue(undefined);
		mocks.getAtprotoOAuthClient.mockResolvedValue({
			callback: vi.fn().mockResolvedValue({
				session: { did: "did:plc:allowed", signOut },
			}),
		});
		mocks.resolveAtprotoProfile.mockResolvedValue({
			displayName: "Allowed User",
			handle: "allowed.example.com",
		});
		mocks.findOrCreateOAuthUser.mockResolvedValue({
			id: "user-1",
			email: "user@example.com",
			name: "Allowed User",
			role: 10,
			disabled: false,
		});
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
								config: { allowedDIDs: ["did:plc:allowed"] },
							},
						],
					},
				},
			},
			redirect,
		} as never);

		expect(response.headers.get("location")).toContain("error=atproto_error");
		expect(signOut).toHaveBeenCalledOnce();
		expect(mocks.deleteProviderSession).toHaveBeenCalledWith("did:plc:allowed");
	});
});
