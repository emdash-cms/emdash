/**
 * The public search endpoint filters drafts by the caller's permissions, so
 * the middleware must resolve the session user for it (soft auth: never
 * blocks). Without this, `status=draft` silently degrades to published even
 * for admins.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const getUserById = vi.fn();
vi.mock("@emdash-cms/auth/adapters/kysely", () => ({
	createKyselyAdapter: vi.fn(() => ({
		getUserById,
		getUserByEmail: vi.fn(),
	})),
}));

type AuthMiddlewareModule = typeof import("../../../src/astro/middleware/auth.js");

let onRequest: AuthMiddlewareModule["onRequest"];

beforeAll(async () => {
	({ onRequest } = await import("../../../src/astro/middleware/auth.js"));
});

beforeEach(() => {
	getUserById.mockReset();
});

async function runSearchRequest(sessionUser: { id: string } | null) {
	const url = new URL("/_emdash/api/search?q=hello&status=draft", "https://site.example.com");
	const session = {
		get: vi.fn().mockResolvedValue(sessionUser),
		set: vi.fn(),
		destroy: vi.fn(),
	};
	const locals: { emdash: object; user?: unknown } = {
		emdash: { db: {}, config: {} },
	};
	const next = vi.fn(async () => new Response("ok"));
	const response = await onRequest(
		{
			url,
			request: new Request(url, { method: "GET" }),
			locals,
			session,
			redirect: (location: string) =>
				new Response(null, { status: 302, headers: { Location: location } }),
		} as Parameters<AuthMiddlewareModule["onRequest"]>[0],
		next,
	);
	return { response, next, locals };
}

describe("search endpoint soft auth", () => {
	it("resolves the session user so the route can filter drafts by permission", async () => {
		const admin = { id: "user-1", role: 50, disabled: false };
		getUserById.mockResolvedValueOnce(admin);

		const { response, next, locals } = await runSearchRequest({ id: "user-1" });

		expect(next).toHaveBeenCalledOnce();
		expect(response.status).toBe(200);
		expect(locals.user).toEqual(admin);
	});

	it("passes anonymous requests through without a user lookup", async () => {
		const { response, next, locals } = await runSearchRequest(null);

		expect(next).toHaveBeenCalledOnce();
		expect(response.status).toBe(200);
		expect(locals.user).toBeUndefined();
		expect(getUserById).not.toHaveBeenCalled();
	});
});
