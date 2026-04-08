import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/auth", () => ({ authenticate: vi.fn() }));
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
		getUserById: vi.fn(async (id: string) => ({
			id,
			email: "admin@test.com",
			name: "Admin",
			role: 50,
			disabled: 0,
		})),
		getUserByEmail: vi.fn(),
	})),
}));

type AuthMiddlewareModule = typeof import("../../../src/astro/middleware/auth.js");

let onRequest: AuthMiddlewareModule["onRequest"];

beforeAll(async () => {
	({ onRequest } = await import("../../../src/astro/middleware/auth.js"));
});

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.clearAllMocks();
});

async function runAuthMiddleware(opts: {
	pathname: string;
	method?: string;
	headers?: HeadersInit;
	sessionUserId?: string | null;
}) {
	const url = new URL(opts.pathname, "https://example.com");
	const session = {
		get: vi.fn().mockResolvedValue(
			opts.sessionUserId ? { id: opts.sessionUserId } : null,
		),
		set: vi.fn(),
		destroy: vi.fn(),
	};
	const next = vi.fn(async () => new Response("ok"));
	const response = await onRequest(
		{
			url,
			request: new Request(url, {
				method: opts.method ?? "POST",
				headers: opts.headers,
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-03-26",
						capabilities: {},
						clientInfo: { name: "debug", version: "1.0" },
					},
				}),
			}),
			locals: {
				emdash: {
					db: {},
					config: {},
				},
			},
			session,
			redirect: (location: string) =>
				new Response(null, {
					status: 302,
					headers: { Location: location },
				}),
		} as Parameters<AuthMiddlewareModule["onRequest"]>[0],
		next,
	);

	return { response, next, session };
}

describe("MCP discovery auth middleware", () => {
	it("returns 401 with discovery metadata for unauthenticated MCP POST requests", async () => {
		const { response, next } = await runAuthMiddleware({
			pathname: "/_emdash/api/mcp",
			headers: { "Content-Type": "application/json" },
		});

		expect(next).not.toHaveBeenCalled();
		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toBe(
			'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
		);
		await expect(response.json()).resolves.toEqual({
			error: { code: "NOT_AUTHENTICATED", message: "Not authenticated" },
		});
	});

	it("returns 401 with discovery metadata for invalid bearer tokens on MCP POST", async () => {
		const { response, next } = await runAuthMiddleware({
			pathname: "/_emdash/api/mcp",
			headers: {
				Authorization: "Bearer invalid",
				"Content-Type": "application/json",
			},
		});

		expect(next).not.toHaveBeenCalled();
		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toBe(
			'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
		);
		await expect(response.json()).resolves.toEqual({
			error: { code: "INVALID_TOKEN", message: "Invalid or expired token" },
		});
	});

	it("still rejects session-backed MCP POST requests without the CSRF header", async () => {
		const { response, next } = await runAuthMiddleware({
			pathname: "/_emdash/api/mcp",
			headers: { "Content-Type": "application/json" },
			sessionUserId: "user_1",
		});

		expect(next).not.toHaveBeenCalled();
		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toEqual({
			error: { code: "CSRF_REJECTED", message: "Missing required header" },
		});
	});

	it("still rejects non-MCP API POST requests without the CSRF header", async () => {
		const { response, next } = await runAuthMiddleware({
			pathname: "/_emdash/api/content/posts",
			headers: { "Content-Type": "application/json" },
		});

		expect(next).not.toHaveBeenCalled();
		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toEqual({
			error: { code: "CSRF_REJECTED", message: "Missing required header" },
		});
	});
});
