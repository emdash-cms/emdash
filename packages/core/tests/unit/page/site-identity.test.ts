/**
 * renderSiteIdentity() Tests
 *
 * Bug context (#831): user-configured site favicons were not emitted into
 * `<head>` by core. The 17 template `Base.astro` files emitted their own
 * `<link rel="icon">` but only when the template had been updated post
 * #448, and even then dropped the `type` attribute, so SVG favicons did
 * not render in Chromium browsers (which require `type="image/svg+xml"`
 * when the URL has no `.svg` extension).
 *
 * Fix: a first-party `renderSiteIdentity()` helper that emits the favicon
 * tag with the correct MIME type. Lives outside the plugin contribution
 * pipeline because that pipeline's `isSafeHref` check rejects same-origin
 * paths like `/_emdash/api/media/file/...`.
 */

import { describe, it, expect } from "vitest";

import { renderSiteIdentity } from "../../../src/page/site-identity.js";

describe("renderSiteIdentity", () => {
	it("returns empty string when no input provided", () => {
		expect(renderSiteIdentity(undefined)).toBe("");
	});

	it("returns empty string when input has no favicon", () => {
		expect(renderSiteIdentity({})).toBe("");
	});

	it("returns empty string when favicon has no resolved URL", () => {
		// Unresolved MediaReference (no url field) should be a no-op.
		expect(
			renderSiteIdentity({
				favicon: { mediaId: "med_123" },
			}),
		).toBe("");
	});

	it("emits link tag for favicon with URL", () => {
		const html = renderSiteIdentity({
			favicon: {
				mediaId: "med_123",
				url: "/_emdash/api/media/file/abc.png",
				contentType: "image/png",
			},
		});
		expect(html).toBe('<link rel="icon" href="/_emdash/api/media/file/abc.png" type="image/png">');
	});

	it("includes type attribute for SVG favicons (the #831 bug)", () => {
		// SVG URLs from EmDash are extension-less (`/_emdash/api/media/file/<ulid>`),
		// so without `type="image/svg+xml"` Chromium will not render them.
		const html = renderSiteIdentity({
			favicon: {
				mediaId: "med_svg",
				url: "/_emdash/api/media/file/01KNTC51CKNJG1RFP3YV93BR17",
				contentType: "image/svg+xml",
			},
		});
		expect(html).toContain('type="image/svg+xml"');
	});

	it("omits type attribute when contentType is not set", () => {
		// Tolerate older stored references that predate contentType resolution.
		const html = renderSiteIdentity({
			favicon: {
				mediaId: "med_legacy",
				url: "/_emdash/api/media/file/legacy.ico",
			},
		});
		expect(html).toBe('<link rel="icon" href="/_emdash/api/media/file/legacy.ico">');
		expect(html).not.toContain("type=");
	});

	it("escapes hostile content in href and type", () => {
		// MediaReference URLs come from a controlled construction in
		// resolveMediaReference, but the renderer should still escape attribute
		// contents defensively.
		const html = renderSiteIdentity({
			favicon: {
				mediaId: "med_x",
				url: '/path"><script>alert(1)</script>',
				contentType: 'image/png"><x',
			},
		});
		expect(html).not.toContain("<script>");
		expect(html).toContain("&quot;");
		expect(html).toContain("&lt;");
	});
});
