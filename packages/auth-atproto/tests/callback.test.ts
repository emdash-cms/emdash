import { AccountDisabledError } from "@emdash-cms/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findOrCreateOAuthUser: vi.fn(),
	getAtprotoOAuthClient: vi.fn(),
	getAtprotoStorage: vi.fn(),
	resolveAtprotoProfile: vi.fn(),
	deleteProviderSessionIfUnchanged: vi.fn(),
	after: vi.fn(),
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

vi.mock("emdash", () => ({
	after: mocks.after,
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

function getDeferredCleanup(): () => Promise<void> {
	const cleanup: unknown = mocks.after.mock.calls[0]?.[0];
	if (typeof cleanup !== "function") throw new Error("Deferred cleanup was not scheduled");
	return async () => cleanup();
}

async function runDeferredCleanup(): Promise<void> {
	await getDeferredCleanup()();
}

function mockProviderSession(
	did: string,
	revoke = vi.fn().mockResolvedValue(undefined),
): {
	accessToken: string;
	revoke: typeof revoke;
	storedSession: { tokenSet: { access_token: string } };
} {
	const accessToken = `token:${did}`;
	const storedSession = { tokenSet: { access_token: accessToken } };
	const callback = vi.fn().mockResolvedValue({
		session: { did, server: { revoke } },
	});
	mocks.getAtprotoOAuthClient.mockImplementation(
		async (
			_baseUrl: string,
			_storage: unknown,
			options?: {
				onSessionStored?: (did: string, session: typeof storedSession) => void;
			},
		) => {
			options?.onSessionStored?.(did, storedSession);
			return { callback };
		},
	);
	return { accessToken, revoke, storedSession };
}

describe("AT Protocol callback", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.deleteProviderSessionIfUnchanged.mockResolvedValue(true);
		mocks.getAtprotoStorage.mockResolvedValue({
			sessions: { deleteIfUnchanged: mocks.deleteProviderSessionIfUnchanged },
		});
	});

	it("removes the provider session when the EmDash account is disabled", async () => {
		const { accessToken, revoke, storedSession } = mockProviderSession("did:plc:disabled");
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

		expect(mocks.deleteProviderSessionIfUnchanged).toHaveBeenCalledWith("did:plc:disabled", {
			value: storedSession,
			expiresAt: null,
		});
		await runDeferredCleanup();
		expect(revoke).toHaveBeenCalledWith(accessToken);
		expect(session.set).not.toHaveBeenCalled();
		expect(response.headers.get("location")).toContain("error=account_disabled");
	});

	it("removes the provider session when the DID is not allowed", async () => {
		const { accessToken, revoke } = mockProviderSession("did:plc:denied");
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
		await runDeferredCleanup();
		expect(revoke).toHaveBeenCalledWith(accessToken);
	});

	it("removes the provider session when profile resolution fails", async () => {
		const revokeError = new Error("Provider revocation failed");
		const revoke = vi.fn().mockRejectedValue(revokeError);
		const { accessToken } = mockProviderSession("did:plc:error", revoke);
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
			await runDeferredCleanup();
			expect(revoke).toHaveBeenCalledWith(accessToken);
			expect(mocks.deleteProviderSessionIfUnchanged).toHaveBeenCalledOnce();
			expect(consoleError).toHaveBeenCalledWith(
				"[atproto-auth] Failed to revoke rejected provider session:",
				revokeError,
			);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("keeps the provider session after authentication succeeds", async () => {
		const { revoke } = mockProviderSession("did:plc:allowed");
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
		expect(revoke).not.toHaveBeenCalled();
		expect(mocks.deleteProviderSessionIfUnchanged).not.toHaveBeenCalled();
		expect(mocks.after).not.toHaveBeenCalled();
	});

	it("does not delete a newer provider session while revocation is pending", async () => {
		let finishRevocation: (() => void) | undefined;
		const revoke = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishRevocation = resolve;
				}),
		);
		const { accessToken, storedSession } = mockProviderSession("did:plc:denied", revoke);
		mocks.deleteProviderSessionIfUnchanged.mockResolvedValue(false);
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
		expect(mocks.after).toHaveBeenCalledOnce();
		expect(revoke).not.toHaveBeenCalled();
		expect(mocks.deleteProviderSessionIfUnchanged).toHaveBeenCalledWith("did:plc:denied", {
			value: storedSession,
			expiresAt: null,
		});

		const cleanup = getDeferredCleanup();
		const cleanupPromise = cleanup();
		await Promise.resolve();
		expect(revoke).toHaveBeenCalledWith(accessToken);

		finishRevocation?.();
		await cleanupPromise;
		expect(mocks.deleteProviderSessionIfUnchanged).toHaveBeenCalledOnce();
	});

	it("bounds rejected provider revocation", async () => {
		vi.useFakeTimers();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const revoke = vi.fn(() => new Promise<void>(() => {}));
			mockProviderSession("did:plc:denied", revoke);
			mocks.resolveAtprotoProfile.mockResolvedValue({
				displayName: "Denied User",
				handle: "denied.example.com",
			});
			const redirect = vi.fn((location: string) =>
				Response.redirect(new URL(location, "https://example.com")),
			);

			await GET({
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

			const cleanup = getDeferredCleanup();
			const cleanupPromise = cleanup();
			await vi.advanceTimersByTimeAsync(4_999);
			expect(mocks.deleteProviderSessionIfUnchanged).toHaveBeenCalledOnce();

			await vi.advanceTimersByTimeAsync(1);
			await cleanupPromise;
			expect(revoke).toHaveBeenCalledOnce();
		} finally {
			consoleError.mockRestore();
			vi.useRealTimers();
		}
	});

	it("rejects authentication when the Astro session is unavailable", async () => {
		const { accessToken, revoke } = mockProviderSession("did:plc:allowed");
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
		await runDeferredCleanup();
		expect(revoke).toHaveBeenCalledWith(accessToken);
		expect(mocks.deleteProviderSessionIfUnchanged).toHaveBeenCalledOnce();
	});
});
