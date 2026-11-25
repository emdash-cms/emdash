import { describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({ defineMiddleware: (handler: unknown) => handler }));

const { sessionStoreEnabled } = await import("../../../src/astro/integration/index.js");

describe("sessionStoreEnabled", () => {
	it("is true only when Astro has a session driver", () => {
		expect(
			sessionStoreEnabled({ driver: { entrypoint: "unstorage/drivers/cloudflare-kv-binding" } }),
		).toBe(true);
		expect(sessionStoreEnabled({ driver: "memory" })).toBe(true);
		for (const session of [
			false,
			undefined,
			null,
			{},
			{ cookie: "astro-session" },
			{ driver: "" },
		]) {
			expect(sessionStoreEnabled(session), JSON.stringify(session)).toBe(false);
		}
	});
});
