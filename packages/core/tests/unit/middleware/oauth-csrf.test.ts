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

async function runAuthMiddleware(opts: {
	pathname: string;
	method?: string;
	origin?: string;
	extraHeaders?: Record<string, string>;
}): Promise<{ response: Response; next: ReturnType<typeof vi.fn> }> {
	const url = new URL(opts.pathname, "https://site.example.com");
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...opts.extraHeaders,
	};
	if (opts.origin) headers.Origin = opts.origin;

	const session = {
		get: vi.fn().mockResolvedValue(null),
		set: vi.fn(),
		destroy: vi.fn(),
	};
	const next = vi.fn(async () => new Response("ok"));
	const response = await onRequest(
		{
			url,
			request: new Request(url, {
				method: opts.method ?? "POST",
				headers,
				body: "{}",
			}),
			locals: {
				emdash: { db: {}, config: {} },
			},
			session,
			redirect: (location: string) =>
				new Response(null, { status: 302, headers: { Location: location } }),
		} as Parameters<AuthMiddlewareModule["onRequest"]>[0],
		next,
	);

	return { response, next };
}

/**
 * OAuth protocol endpoints (RFC 6749, 7591, 8628) are designed to be called
 * cross-origin. They must bypass the Origin-based CSRF check that applies to
 * other public API routes.
 *
 * Regression test for PR #671: dynamic client registration and the token
 * endpoint were unreachable from real MCP clients because an Origin header
 * from a different origin triggered CSRF_REJECTED in middleware.
 */
describe("CSRF exemption for OAuth protocol endpoints", () => {
	const EXEMPT_PATHS = [
		"/_emdash/api/oauth/token",
		"/_emdash/api/oauth/register",
		"/_emdash/api/oauth/device/code",
		"/_emdash/api/oauth/device/token",
	] as const;

	it.each(EXEMPT_PATHS)(
		"allows cross-origin POST to %s (passes request through to handler)",
		async (pathname) => {
			const { response, next } = await runAuthMiddleware({
				pathname,
				origin: "https://claude.ai",
			});

			expect(next).toHaveBeenCalledOnce();
			expect(response.status).toBe(200);
		},
	);

	it.each(EXEMPT_PATHS)("allows same-origin POST to %s", async (pathname) => {
		const { response, next } = await runAuthMiddleware({
			pathname,
			origin: "https://site.example.com",
		});

		expect(next).toHaveBeenCalledOnce();
		expect(response.status).toBe(200);
	});

	it.each(EXEMPT_PATHS)("allows POST without any Origin header to %s", async (pathname) => {
		const { response, next } = await runAuthMiddleware({ pathname });

		expect(next).toHaveBeenCalledOnce();
		expect(response.status).toBe(200);
	});

	it("still rejects cross-origin POST to non-exempt public routes (comments)", async () => {
		const { response, next } = await runAuthMiddleware({
			pathname: "/_emdash/api/comments/some-id",
			origin: "https://evil.example.com",
		});

		expect(next).not.toHaveBeenCalled();
		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toEqual({
			error: { code: "CSRF_REJECTED", message: "Cross-origin request blocked" },
		});
	});

	it("still rejects cross-origin POST to device/authorize (session-authenticated consent step)", async () => {
		// /oauth/device/authorize is NOT in the exempt list — it's where the user
		// approves the CLI's device code from their browser session. It must be
		// protected by the normal CSRF check.
		const { response, next } = await runAuthMiddleware({
			pathname: "/_emdash/api/oauth/device/authorize",
			origin: "https://evil.example.com",
		});

		expect(next).not.toHaveBeenCalled();
		expect(response.status).toBe(403);
	});
});
