import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));
vi.mock("virtual:emdash/auth", () => ({ authenticate: vi.fn() }), { virtual: true });
vi.mock("virtual:emdash/config", () => ({ default: {} }), { virtual: true });
vi.mock("../../../src/astro/session-user.js", () => ({ resolveSessionUser: vi.fn() }));

type AuthMiddlewareModule = typeof import("../../../src/astro/middleware/auth.js");

let onRequest: AuthMiddlewareModule["onRequest"];

beforeAll(async () => {
	({ onRequest } = await import("../../../src/astro/middleware/auth.js"));
});

describe("domain proof endpoint", () => {
	it("accepts the anonymous server-to-server request a domain check sends", async () => {
		const url = new URL("https://new.example/_emdash/api/site/domain-proof");
		const next = vi.fn(async () => new Response("ok"));
		const context = {
			url,
			request: new Request(url, {
				method: "POST",
				headers: { Accept: "application/json", "X-EmDash-Request": "1" },
			}),
			locals: { emdash: { db: {}, config: {} } },
			session: { get: vi.fn(), set: vi.fn(), destroy: vi.fn() },
			redirect: vi.fn(),
		};

		const response = await onRequest(
			context as unknown as Parameters<AuthMiddlewareModule["onRequest"]>[0],
			next,
		);

		expect(response.status).toBe(200);
		expect(next).toHaveBeenCalledOnce();
	});
});
