/**
 * Regression tests: preview and toolbar responses must opt out of Astro's
 * route cache, not just set `Cache-Control`.
 *
 * `Cache-Control: private, no-store` governs browsers and downstream
 * proxies, but the shared edge cache (e.g. Workers Cache on Cloudflare)
 * follows the route-cache options — on Cloudflare the adapter emits
 * `Cloudflare-CDN-Cache-Control` from them. Verified on a stock deploy:
 * a valid preview URL was a MISS on request 1 and a shared-cache HIT on
 * requests 2+, i.e. draft content was served without any token
 * verification until TTL/purge, even after token expiry.
 *
 * The fix calls `context.cache.set(false)` for requests carrying a
 * `_preview` param and for toolbar-injected editor responses.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

import onRequest from "../../../src/astro/middleware/request-context.js";

function buildContext(opts: {
	pathname?: string;
	search?: string;
	user?: { id: string; role: number } | null;
	editCookie?: boolean;
	cache: { set: (input: unknown) => void };
}) {
	const url = new URL(`https://example.com${opts.pathname ?? "/blog"}${opts.search ?? ""}`);
	return {
		request: new Request(url),
		url,
		cookies: {
			get: vi.fn((name: string) =>
				name === "emdash-edit-mode" && opts.editCookie ? { value: "true" } : undefined,
			),
			set: vi.fn(),
		},
		locals: { user: opts.user ?? null },
		cache: opts.cache,
	} as unknown as Parameters<typeof onRequest>[0];
}

const htmlResponse = () =>
	new Response("<html><body>hello</body></html>", {
		headers: { "content-type": "text/html" },
	});

describe("route-cache opt-out for preview and toolbar responses", () => {
	it("opts out of the route cache when a _preview param is present", async () => {
		const cache = { set: vi.fn() };
		// No emdash.db on locals — token can't be verified, but the response
		// still must not be stored under the per-token URL.
		const context = buildContext({ search: "?_preview=some-token", cache });

		await onRequest(context, async () => htmlResponse());

		expect(cache.set).toHaveBeenCalledWith(false);
	});

	it("opts out of the route cache when the toolbar is injected", async () => {
		const cache = { set: vi.fn() };
		const context = buildContext({ user: { id: "u1", role: 30 }, cache });

		const response = await onRequest(context, async () => htmlResponse());

		// Confirm we're on the actual-injection path.
		expect(await response.text()).toContain('id="emdash-toolbar"');
		expect(cache.set).toHaveBeenCalledWith(false);
	});

	it("leaves the route cache alone for editor requests without injection (non-HTML)", async () => {
		const cache = { set: vi.fn() };
		const context = buildContext({
			pathname: "/api/data.json",
			user: { id: "u1", role: 30 },
			cache,
		});

		await onRequest(
			context,
			async () => new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
		);

		expect(cache.set).not.toHaveBeenCalled();
	});

	it("leaves the route cache alone for anonymous requests without CMS signals", async () => {
		const cache = { set: vi.fn() };
		const context = buildContext({ cache });

		await onRequest(context, async () => htmlResponse());

		expect(cache.set).not.toHaveBeenCalled();
	});
});
