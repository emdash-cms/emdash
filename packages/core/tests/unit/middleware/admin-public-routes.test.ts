import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/auth", () => ({ authenticate: vi.fn() }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));
vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));
vi.mock("@emdash-cms/auth", () => ({
	TOKEN_PREFIXES: {},
	generatePrefixedToken: vi.fn(),
	hashPrefixedToken: vi.fn(),
	VALID_SCOPES: [],
	validateScopes: vi.fn(),
	hasScope: vi.fn(() => false),
	computeS256Challenge: vi.fn(),
	Role: { ADMIN: 50 },
}));
vi.mock("@emdash-cms/auth/adapters/kysely", () => ({
	createKyselyAdapter: vi.fn(() => ({
		getUserById: vi.fn(),
		getUserByEmail: vi.fn(),
	})),
}));

type AuthMiddlewareModule = typeof import("../../../src/astro/middleware/auth.js");

let onRequest: AuthMiddlewareModule["onRequest"];

beforeAll(async () => {
	({ onRequest } = await import("../../../src/astro/middleware/auth.js"));
});

/** An anonymous GET to an admin page. */
async function visit(pathname: string): Promise<{ response: Response; next: ReturnType<typeof vi.fn> }> {
	const url = new URL(pathname, "https://site.example.com");
	const session = {
		get: vi.fn().mockResolvedValue(null),
		set: vi.fn(),
		destroy: vi.fn(),
	};
	const next = vi.fn(async () => new Response("ok"));
	const response = await onRequest(
		{
			url,
			request: new Request(url, { method: "GET" }),
			locals: { emdash: { db: {}, config: {} } },
			session,
			redirect: (location: string) =>
				new Response(null, { status: 302, headers: { Location: location } }),
		} as Parameters<AuthMiddlewareModule["onRequest"]>[0],
		next,
	);
	return { response, next };
}

describe("Anonymous access to admin pages", () => {
	it.each([
		"/_emdash/admin/login",
		"/_emdash/admin/signup?token=abc",
		"/_emdash/admin/invite/accept?token=abc",
	])("serves %s without a session — emails link there", async (pathname) => {
		const { response, next } = await visit(pathname);
		expect(next).toHaveBeenCalledOnce();
		expect(response.status).toBe(200);
	});

	it("redirects other admin pages to login, keeping the full URL to return to", async () => {
		const { response, next } = await visit("/_emdash/admin/content/posts?token=abc&x=1");
		expect(next).not.toHaveBeenCalled();
		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("Location")!);
		expect(location.pathname).toBe("/_emdash/admin/login");
		expect(location.searchParams.get("redirect")).toBe("/_emdash/admin/content/posts?token=abc&x=1");
	});
});
