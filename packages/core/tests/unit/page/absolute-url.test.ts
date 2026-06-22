import { describe, expect, it } from "vitest";

import { absolutizeMediaUrl, resolveSiteOrigin } from "../../../src/page/absolute-url.js";
import type { PublicPageContext } from "../../../src/plugins/types.js";

function createPage(overrides: Partial<PublicPageContext> = {}): PublicPageContext {
	return {
		url: "https://example.com/posts/hello",
		path: "/posts/hello",
		locale: null,
		kind: "content",
		pageType: "article",
		title: "Hello",
		description: null,
		canonical: "https://example.com/posts/hello",
		image: null,
		...overrides,
	};
}

describe("resolveSiteOrigin", () => {
	it("prefers configured site URL when valid", () => {
		const page = createPage({ siteUrl: "https://page.example.com" });
		expect(resolveSiteOrigin("https://configured.example.com", page)).toBe(
			"https://configured.example.com",
		);
	});

	it("strips path and query from configured URL, keeping origin", () => {
		const page = createPage();
		expect(resolveSiteOrigin("https://configured.example.com/some/path?q=1", page)).toBe(
			"https://configured.example.com",
		);
	});

	it("falls back to page.siteUrl when configured is unset", () => {
		const page = createPage({ siteUrl: "https://page.example.com/extra" });
		expect(resolveSiteOrigin(undefined, page)).toBe("https://page.example.com");
	});

	it("falls back to page.url origin when neither configured nor siteUrl is set", () => {
		const page = createPage();
		expect(resolveSiteOrigin(undefined, page)).toBe("https://example.com");
	});

	it("skips unparseable configured URL and uses next candidate", () => {
		// "example.com" without scheme cannot be parsed by URL.
		const page = createPage({ siteUrl: "https://page.example.com" });
		expect(resolveSiteOrigin("example.com", page)).toBe("https://page.example.com");
	});

	it("returns null when all candidates are unparseable", () => {
		const page = createPage({ url: "not a url", siteUrl: "also not a url" });
		expect(resolveSiteOrigin("nope", page)).toBeNull();
	});
});

describe("absolutizeMediaUrl", () => {
	it("returns null for undefined", () => {
		expect(absolutizeMediaUrl(undefined, "https://example.com", createPage())).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(absolutizeMediaUrl("", "https://example.com", createPage())).toBeNull();
	});

	it("passes through already-absolute https URL unchanged", () => {
		const page = createPage();
		const url = "https://cdn.example.com/image.png";
		expect(absolutizeMediaUrl(url, "https://example.com", page)).toBe(url);
	});

	it("passes through already-absolute http URL unchanged", () => {
		const page = createPage();
		const url = "http://cdn.example.com/image.png";
		expect(absolutizeMediaUrl(url, "https://example.com", page)).toBe(url);
	});

	it("joins relative URL with configured site origin", () => {
		const page = createPage();
		expect(absolutizeMediaUrl("/_emdash/api/media/file/abc.png", "https://example.com", page)).toBe(
			"https://example.com/_emdash/api/media/file/abc.png",
		);
	});

	it("strips trailing slash from configured origin before joining", () => {
		const page = createPage();
		expect(
			absolutizeMediaUrl("/_emdash/api/media/file/abc.png", "https://example.com/", page),
		).toBe("https://example.com/_emdash/api/media/file/abc.png");
	});

	it("falls back to page.siteUrl when configured site URL is missing", () => {
		const page = createPage({ siteUrl: "https://proxy.example.com" });
		expect(absolutizeMediaUrl("/og.png", undefined, page)).toBe("https://proxy.example.com/og.png");
	});

	it("falls back to page.url origin when no configured URL or siteUrl set", () => {
		const page = createPage({ url: "https://live.example.com/some/page" });
		expect(absolutizeMediaUrl("/og.png", undefined, page)).toBe("https://live.example.com/og.png");
	});

	it("prepends slash to relative URL without leading slash", () => {
		const page = createPage();
		expect(absolutizeMediaUrl("og.png", "https://example.com", page)).toBe(
			"https://example.com/og.png",
		);
	});

	it("returns original relative URL when no origin can be resolved", () => {
		// Construct a page where every origin candidate is unparseable.
		// Better to emit a relative URL than to drop og:image entirely;
		// some scrapers do resolve relative URLs against the page URL.
		const page = createPage({ url: "garbage", siteUrl: undefined });
		expect(absolutizeMediaUrl("/og.png", undefined, page)).toBe("/og.png");
	});

	describe("scheme handling", () => {
		it("passes through data:image/* URLs unchanged", () => {
			// data:image/* URLs are valid OG image values in some contexts;
			// rewriting them into `https://site/data:...` produces garbage.
			const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
			expect(absolutizeMediaUrl(dataUrl, "https://example.com", createPage())).toBe(dataUrl);
		});

		it("returns null for non-image data: URLs", () => {
			// `data:text/plain` etc. are not valid OG images.
			expect(
				absolutizeMediaUrl("data:text/plain,hello", "https://example.com", createPage()),
			).toBeNull();
		});

		it("returns null for blob: URLs", () => {
			// blob: URLs are browser-only references that no crawler can resolve.
			expect(
				absolutizeMediaUrl("blob:https://example.com/abc", "https://example.com", createPage()),
			).toBeNull();
		});

		it("returns null for mailto: URLs", () => {
			expect(
				absolutizeMediaUrl("mailto:hi@example.com", "https://example.com", createPage()),
			).toBeNull();
		});

		it("returns null for file: URLs", () => {
			// file: URLs leak local-FS config mistakes into crawler-visible markup.
			expect(
				absolutizeMediaUrl("file:///etc/passwd", "https://example.com", createPage()),
			).toBeNull();
		});

		it("returns null for protocol-relative URLs (SSRF guard)", () => {
			// Protocol-relative URLs have no legitimate `og:image` use case and
			// are a well-known SSRF vector when reflected through server-side
			// fetchers. We drop them outright.
			const page = createPage();
			expect(
				absolutizeMediaUrl("//cdn.example.com/og.png", "https://example.com", page),
			).toBeNull();
		});

		it("returns null for protocol-relative URLs even when no origin resolves", () => {
			// Drop happens before origin resolution, so a malformed page context
			// can't accidentally let one through.
			const page = createPage({ url: "garbage", siteUrl: undefined });
			expect(absolutizeMediaUrl("//cdn.example.com/og.png", undefined, page)).toBeNull();
		});

		it("returns null for unknown custom schemes", () => {
			expect(
				absolutizeMediaUrl("javascript:alert(1)", "https://example.com", createPage()),
			).toBeNull();
			expect(absolutizeMediaUrl("foo:bar/baz", "https://example.com", createPage())).toBeNull();
		});
	});

	describe("whitespace / control char defense", () => {
		// Real media URLs never contain whitespace or control characters.
		// Rejecting them up front prevents scheme-regex evasion: an input
		// like "  https://attacker/x" would otherwise slip past HTTP_URL_RE
		// (anchored at offset 0) and get joined as a relative path with the
		// site origin.

		it("rejects URLs with leading spaces", () => {
			expect(
				absolutizeMediaUrl("  https://attacker.example/x.png", "https://example.com", createPage()),
			).toBeNull();
		});

		it("rejects URLs with leading tabs", () => {
			expect(
				absolutizeMediaUrl("\thttps://attacker.example/x.png", "https://example.com", createPage()),
			).toBeNull();
		});

		it("rejects URLs with leading newlines (header injection vector)", () => {
			expect(
				absolutizeMediaUrl("\nhttps://attacker.example/x.png", "https://example.com", createPage()),
			).toBeNull();
			expect(
				absolutizeMediaUrl(
					"\r\nhttps://attacker.example/x.png",
					"https://example.com",
					createPage(),
				),
			).toBeNull();
		});

		it("rejects URLs with embedded whitespace", () => {
			expect(
				absolutizeMediaUrl(
					"https://example.com/path with space.png",
					"https://example.com",
					createPage(),
				),
			).toBeNull();
		});

		it("rejects URLs with control characters", () => {
			// C0 control (NUL) — never valid in a URL.
			expect(
				absolutizeMediaUrl("https://example.com/\u0000.png", "https://example.com", createPage()),
			).toBeNull();
			// DEL.
			expect(
				absolutizeMediaUrl("https://example.com/\u007f.png", "https://example.com", createPage()),
			).toBeNull();
		});

		it("rejects space-prefixed protocol-relative URLs", () => {
			// Without the whitespace guard, " //evil" wouldn't match
			// PROTOCOL_RELATIVE_RE either and would be joined as a relative
			// path.
			expect(
				absolutizeMediaUrl(" //attacker.example/x.png", "https://example.com", createPage()),
			).toBeNull();
		});
	});

	describe("opaque origin rejection", () => {
		it("rejects data: configured site URL and falls back to next candidate", () => {
			// `new URL("data:...").origin` returns the literal string "null".
			// Don't emit `null/og.png`.
			const page = createPage({ siteUrl: "https://page.example.com" });
			expect(absolutizeMediaUrl("/og.png", "data:text/plain,hello", page)).toBe(
				"https://page.example.com/og.png",
			);
		});

		it("rejects file: URLs in the origin chain", () => {
			const page = createPage({
				url: "https://live.example.com/x",
				siteUrl: "file:///local/path",
			});
			expect(absolutizeMediaUrl("/og.png", undefined, page)).toBe(
				"https://live.example.com/og.png",
			);
		});
	});
});
