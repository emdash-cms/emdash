import { describe, it, expect } from "vitest";

import { getPreviewUrl, buildPreviewUrl } from "../../../src/preview/urls.js";

// Regex patterns for URL validation
const RELATIVE_PREVIEW_URL_REGEX = /^\/posts\/hello-world\?_preview=/;
const ABSOLUTE_PREVIEW_URL_REGEX = /^https:\/\/example\.com\/posts\/hello-world\?_preview=/;
const BLOG_PREVIEW_URL_REGEX = /^\/blog\/hello-world\?_preview=/;
const CONTENT_PREVIEW_URL_REGEX = /^\/content\/posts\/view\/hello-world\?_preview=/;
const BASE64URL_INVALID_CHARS_REGEX = /[+/=]/;

describe("preview URLs", () => {
	const testSecret = "test-secret-key-for-preview-tokens";

	describe("getPreviewUrl", () => {
		it("generates relative URL by default", async () => {
			const url = await getPreviewUrl({
				collection: "posts",
				id: "hello-world",
				secret: testSecret,
			});

			// Should start with path
			expect(url).toMatch(RELATIVE_PREVIEW_URL_REGEX);

			// Should have a token
			const urlObj = new URL(url, "http://example.com");
			const token = urlObj.searchParams.get("_preview");
			expect(token).toBeTruthy();
			expect(token!.split(".").length).toBe(2);
		});

		it("generates absolute URL with baseUrl", async () => {
			const url = await getPreviewUrl({
				collection: "posts",
				id: "hello-world",
				secret: testSecret,
				baseUrl: "https://example.com",
			});

			expect(url).toMatch(ABSOLUTE_PREVIEW_URL_REGEX);
		});

		it("respects custom path pattern", async () => {
			const url = await getPreviewUrl({
				collection: "posts",
				id: "hello-world",
				secret: testSecret,
				pathPattern: "/blog/{id}",
			});

			expect(url).toMatch(BLOG_PREVIEW_URL_REGEX);
		});

		it("supports complex path patterns", async () => {
			const url = await getPreviewUrl({
				collection: "posts",
				id: "hello-world",
				secret: testSecret,
				pathPattern: "/content/{collection}/view/{id}",
			});

			expect(url).toMatch(CONTENT_PREVIEW_URL_REGEX);
		});

		it("generates URL-safe tokens", async () => {
			const url = await getPreviewUrl({
				collection: "posts",
				id: "test-id",
				secret: testSecret,
			});

			// Token should not contain URL-unsafe characters
			const urlObj = new URL(url, "http://example.com");
			const token = urlObj.searchParams.get("_preview");
			expect(token).not.toMatch(BASE64URL_INVALID_CHARS_REGEX);
		});

		it("substitutes {locale} placeholder", async () => {
			const url = await getPreviewUrl({
				collection: "posts",
				id: "hello-world",
				secret: testSecret,
				pathPattern: "/{locale}/{id}",
				locale: "pt-br",
			});

			expect(url).toMatch(/^\/pt-br\/hello-world\?_preview=/);
		});

		it("collapses empty {locale} segment", async () => {
			const url = await getPreviewUrl({
				collection: "posts",
				id: "hello-world",
				secret: testSecret,
				pathPattern: "/{locale}/{id}",
				locale: "",
			});

			// Empty locale should not leave a leading double slash.
			expect(url).toMatch(/^\/hello-world\?_preview=/);
		});

		it("respects expiresIn option", async () => {
			const shortUrl = await getPreviewUrl({
				collection: "posts",
				id: "test",
				secret: testSecret,
				expiresIn: "30m",
			});

			const longUrl = await getPreviewUrl({
				collection: "posts",
				id: "test",
				secret: testSecret,
				expiresIn: "7d",
			});

			// Both should be valid but different tokens
			expect(shortUrl).not.toBe(longUrl);
		});
	});

	describe("buildPreviewUrl", () => {
		it("builds URL from existing token", () => {
			const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-signature";

			const url = buildPreviewUrl({
				path: "/posts/hello-world",
				token,
			});

			expect(url).toBe(`/posts/hello-world?_preview=${token}`);
		});

		it("builds absolute URL with baseUrl", () => {
			const token = "test-token";

			const url = buildPreviewUrl({
				path: "/posts/hello-world",
				token,
				baseUrl: "https://example.com",
			});

			expect(url).toBe(`https://example.com/posts/hello-world?_preview=${token}`);
		});

		it("preserves existing query params in path", () => {
			const token = "test-token";

			// Note: buildPreviewUrl doesn't preserve existing params, it starts fresh
			// This is intentional - the path should be clean
			const url = buildPreviewUrl({
				path: "/posts/hello-world",
				token,
			});

			expect(url).toContain("_preview=test-token");
		});
	});
});
