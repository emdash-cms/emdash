import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/auth", () => ({ authenticate: vi.fn() }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));
vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { resolveApiToken } = vi.hoisted(() => ({
	resolveApiToken: vi.fn<() => Promise<{ userId: string; scopes: string[] } | null>>(),
}));
vi.mock("../../../src/api/handlers/api-tokens.js", () => ({
	resolveApiToken,
	resolveOAuthToken: vi.fn(async () => null),
}));

vi.mock("@emdash-cms/auth/adapters/kysely", () => ({
	createKyselyAdapter: vi.fn(() => ({
		getUserById: vi.fn(async (id: string) => ({ id, role: 50, disabled: false })),
		getUserByEmail: vi.fn(),
	})),
}));

type AuthMiddlewareModule = typeof import("../../../src/astro/middleware/auth.js");

let onRequest: AuthMiddlewareModule["onRequest"];

beforeAll(async () => {
	({ onRequest } = await import("../../../src/astro/middleware/auth.js"));
});

beforeEach(() => {
	resolveApiToken.mockReset();
});

async function requestWithToken(scopes: string[], pathname: string, method = "GET") {
	resolveApiToken.mockResolvedValue({ userId: "user-1", scopes });
	const url = new URL(pathname, "https://site.example.com");
	const next = vi.fn(async () => new Response("ok"));
	const response = await onRequest(
		{
			url,
			request: new Request(url, {
				method,
				headers: { Authorization: "Bearer ec_pat_example" },
			}),
			locals: { emdash: { db: {}, config: {} } },
			session: { get: vi.fn(), set: vi.fn(), destroy: vi.fn() },
			redirect: (location: string) =>
				new Response(null, { status: 302, headers: { Location: location } }),
		} as unknown as Parameters<AuthMiddlewareModule["onRequest"]>[0],
		next,
	);
	return { response, next };
}

describe("token scope enforcement for site transfer routes", () => {
	it.each(["GET", "POST"])("lets an admin-only token through (%s)", async (method) => {
		const { next } = await requestWithToken(
			["admin"],
			"/_emdash/api/admin/transfer/export",
			method,
		);
		expect(next).toHaveBeenCalledOnce();
	});

	it("rejects a token without admin or a transfer scope", async () => {
		const { response, next } = await requestWithToken(
			["content:write", "settings:manage"],
			"/_emdash/api/admin/transfer/imports",
			"POST",
		);

		expect(next).not.toHaveBeenCalled();
		expect(response.status).toBe(403);
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe("INSUFFICIENT_SCOPE");
	});

	it.each(["transfer:export", "transfer:analyze", "transfer:execute"])(
		"lets a %s token through to the transfer route",
		async (scope) => {
			const { response, next } = await requestWithToken(
				[scope],
				"/_emdash/api/admin/transfer/imports/abc",
				"POST",
			);

			expect(next).toHaveBeenCalledOnce();
			expect(response.status).toBe(200);
		},
	);

	it("matches the exact transfer prefix", async () => {
		const { next } = await requestWithToken(["transfer:analyze"], "/_emdash/api/admin/transfer");
		expect(next).toHaveBeenCalledOnce();
	});

	it.each([
		"/_emdash/api/admin/api-tokens",
		"/_emdash/api/admin/transfers",
		"/_emdash/api/admin/users",
		"/_emdash/api/content/posts",
	])("keeps a transfer-only token out of %s", async (pathname) => {
		const { response, next } = await requestWithToken(["transfer:analyze"], pathname);

		expect(next).not.toHaveBeenCalled();
		expect(response.status).toBe(403);
	});

	it("still lets admin tokens use other admin routes", async () => {
		const { next } = await requestWithToken(["admin"], "/_emdash/api/admin/api-tokens");
		expect(next).toHaveBeenCalledOnce();
	});
});
