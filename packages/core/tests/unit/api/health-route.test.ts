import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

vi.mock(
	"virtual:emdash/auth",
	() => ({
		authenticate: vi.fn(),
	}),
	{ virtual: true },
);

vi.mock(
	"virtual:emdash/config",
	() => ({
		default: {},
	}),
	{ virtual: true },
);

import { injectCoreRoutes } from "../../../src/astro/integration/routes.js";
import { GET } from "../../../src/astro/routes/api/health.js";

let authMiddleware: typeof import("../../../src/astro/middleware/auth.js").onRequest;

beforeAll(async () => {
	({ onRequest: authMiddleware } = await import("../../../src/astro/middleware/auth.js"));
});

describe("EmDash health endpoint", () => {
	it("reports registry availability without database access", async () => {
		const response = await GET({
			locals: {
				emdash: {
					config: { experimental: { registry: "https://registry.example.com" } },
				},
			},
		} as never);

		expect(response.status).toBe(200);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		await expect(response.json()).resolves.toEqual({
			success: true,
			data: { product: "emdash", version: "dev", registry: true },
		});
	});

	it("reports the registry as disabled when the top-level option is false", async () => {
		const response = await GET({
			locals: {
				emdash: {
					config: {
						registry: false,
						experimental: { registry: "https://registry.example.com" },
					},
				},
			},
		} as never);

		await expect(response.json()).resolves.toMatchObject({ data: { registry: false } });
	});

	it("is registered as a core route", () => {
		const routes: Array<{ pattern: string }> = [];
		injectCoreRoutes((route) => routes.push(route));

		expect(routes).toContainEqual(expect.objectContaining({ pattern: "/_emdash/api/health" }));
	});

	it("remains reachable without authentication", async () => {
		const url = new URL("https://site.example/_emdash/api/health");
		const next = vi.fn(() =>
			GET({
				locals: { emdash: { config: { experimental: {} } } },
			} as never),
		);
		const sessionGet = vi.fn();

		const response = await authMiddleware(
			{
				url,
				request: new Request(url),
				locals: { emdash: { config: { experimental: {} } } },
				session: { get: sessionGet },
			} as never,
			next,
		);

		expect(response.status).toBe(200);
		expect(next).toHaveBeenCalledOnce();
		expect(sessionGet).not.toHaveBeenCalled();
	});
});
