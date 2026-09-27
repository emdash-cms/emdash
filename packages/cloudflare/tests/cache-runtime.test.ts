import { beforeEach, describe, expect, it, vi } from "vitest";

const cache = {
	match: vi.fn(),
	put: vi.fn(),
	delete: vi.fn(),
};

const open = vi.fn();
const waitUntil = vi.fn();

vi.mock("cloudflare:workers", () => ({
	env: {},
	waitUntil,
}));

describe("cloudflare cache runtime", () => {
	beforeEach(() => {
		cache.match.mockReset();
		cache.put.mockReset();
		cache.delete.mockReset();
		open.mockReset();
		waitUntil.mockReset();

		vi.stubGlobal("caches", { open });
		open.mockResolvedValue(cache);
		cache.match.mockResolvedValue(undefined);
		cache.put.mockImplementation(() => new Promise<void>(() => {}));
	});

	it("does not block a route-cache miss on cache storage", async () => {
		const { default: createCacheProvider } = await import("../src/cache/runtime.js");
		const provider = createCacheProvider({ cacheName: "test" });
		const onRequest = provider.onRequest;
		const request = new Request("https://example.com/categories");

		expect(onRequest).toBeDefined();

		const response = await onRequest!(
			{
				request,
				url: new URL(request.url),
			},
			() =>
				Promise.resolve(
					new Response("fresh page", {
						headers: { "CDN-Cache-Control": "max-age=60, stale-while-revalidate=120" },
					}),
				),
		);

		expect(response.headers.get("X-Astro-Cache")).toBe("MISS");
		expect(await response.text()).toBe("fresh page");
		expect(cache.put).toHaveBeenCalledOnce();
		expect(waitUntil).toHaveBeenCalledOnce();
		expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
	});
});
