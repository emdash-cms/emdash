import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { getUserById, resolveSessionUser } = vi.hoisted(() => ({
	getUserById: vi.fn(),
	resolveSessionUser: vi.fn(),
}));

vi.mock("virtual:emdash/auth", () => ({ authenticate: vi.fn() }), { virtual: true });
vi.mock("virtual:emdash/config", () => ({ default: {} }), { virtual: true });
vi.mock("@emdash-cms/auth/adapters/kysely", () => ({
	createKyselyAdapter: () => ({ getUserById }),
}));
vi.mock("../../../src/astro/session-user.js", () => ({ resolveSessionUser }));

type AuthMiddlewareModule = typeof import("../../../src/astro/middleware/auth.js");

let onRequest: AuthMiddlewareModule["onRequest"];

beforeAll(async () => {
	({ onRequest } = await import("../../../src/astro/middleware/auth.js"));
});

beforeEach(() => {
	getUserById.mockReset();
	resolveSessionUser.mockReset();
});

function createContext(pathname = "/_emdash/api/comments/posts/post-1", method = "POST") {
	const url = new URL(pathname, "https://site.example.com");
	const locals: Record<string, unknown> & {
		user?: { id: string; email: string; disabled: boolean };
	} = {
		emdash: { db: {}, config: {} },
	};
	const session = {
		get: vi.fn(),
		set: vi.fn(),
		destroy: vi.fn(),
	};
	const next = vi.fn(async () => new Response("ok"));
	const requestInit: RequestInit = {
		method,
		headers: {
			"Content-Type": "application/json",
			Origin: url.origin,
		},
	};
	if (method !== "GET" && method !== "HEAD") requestInit.body = "{}";

	return {
		locals,
		next,
		context: {
			url,
			request: new Request(url, requestInit),
			locals,
			session,
			redirect: vi.fn(),
		},
	};
}

describe("session auth on the public comments API", () => {
	it("sets locals.user when a valid CMS session submits a comment", async () => {
		resolveSessionUser.mockResolvedValue({ id: "user-1" });
		getUserById.mockResolvedValue({
			id: "user-1",
			email: "admin@example.com",
			disabled: false,
		});
		const { context, locals, next } = createContext();

		const response = await onRequest(
			context as Parameters<AuthMiddlewareModule["onRequest"]>[0],
			next,
		);

		expect(response.status).toBe(200);
		expect(next).toHaveBeenCalledOnce();
		expect(locals.user).toMatchObject({ id: "user-1", email: "admin@example.com" });
	});

	it("continues anonymously when no CMS session exists", async () => {
		resolveSessionUser.mockResolvedValue(null);
		const { context, locals, next } = createContext();

		const response = await onRequest(
			context as Parameters<AuthMiddlewareModule["onRequest"]>[0],
			next,
		);

		expect(response.status).toBe(200);
		expect(next).toHaveBeenCalledOnce();
		expect(locals.user).toBeUndefined();
	});

	it.each([
		["comment list requests", "GET", "/_emdash/api/comments/posts/post-1"],
		["comment reaction requests", "POST", "/_emdash/api/comments/posts/post-1/reactions"],
	])("does not resolve a CMS session for %s", async (_label, method, pathname) => {
		resolveSessionUser.mockResolvedValue({ id: "user-1" });
		getUserById.mockResolvedValue({
			id: "user-1",
			email: "admin@example.com",
			disabled: false,
		});
		const { context, locals, next } = createContext(pathname, method);

		const response = await onRequest(
			context as Parameters<AuthMiddlewareModule["onRequest"]>[0],
			next,
		);

		expect(response.status).toBe(200);
		expect(next).toHaveBeenCalledOnce();
		expect(resolveSessionUser).not.toHaveBeenCalled();
		expect(getUserById).not.toHaveBeenCalled();
		expect(locals.user).toBeUndefined();
	});
});
