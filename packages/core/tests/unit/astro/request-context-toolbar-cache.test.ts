/**
 * Regression tests for issue #1398: the editor-toolbar injection path did not
 * set `Cache-Control: private, no-store`, unlike the preview path. On a site
 * fronted by a shared cache, a logged-in editor merely browsing the public site
 * primed the edge cache with toolbar-bearing HTML that was then served to all
 * anonymous visitors — leaking the toolbar markup and the fact a session was
 * active.
 *
 * The fix sets `Cache-Control: private, no-store` on any toolbar-injected
 * response (centralized in `injectToolbar`), mirroring the preview branch.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

import onRequest from "../../../src/astro/middleware/request-context.js";

/** A public-page request from a logged-in editor with no edit cookie / preview token. */
function editorRequestContext(pathname = "/blog") {
	return {
		request: new Request(`https://example.com${pathname}`),
		url: new URL(`https://example.com${pathname}`),
		cookies: { get: vi.fn(() => undefined), set: vi.fn() },
		locals: { user: { id: "u1", role: 30 } },
	} as unknown as Parameters<typeof onRequest>[0];
}

describe("editor toolbar injection cache headers (issue #1398)", () => {
	it("sets Cache-Control: private, no-store on toolbar-injected HTML", async () => {
		const context = editorRequestContext();

		const response = await onRequest(
			context,
			async () =>
				new Response("<html><body>hello</body></html>", {
					headers: { "content-type": "text/html" },
				}),
		);

		const body = await response.text();
		// Confirm we are on the actual-injection path, not an early return.
		expect(body).toContain('id="emdash-toolbar"');
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	});

	it("does not force no-store on non-HTML responses (no toolbar injected)", async () => {
		const context = editorRequestContext("/api/data.json");

		const response = await onRequest(
			context,
			async () =>
				new Response('{"ok":true}', {
					headers: { "content-type": "application/json" },
				}),
		);

		// No toolbar was injected, so the response is not session-specific and
		// must retain its original cacheability.
		expect(response.headers.get("Cache-Control")).toBeNull();
	});
});
