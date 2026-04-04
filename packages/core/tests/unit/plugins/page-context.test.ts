/**
 * Page Context Tests
 *
 * Tests the public page context builder for:
 * - Astro-like input handling
 * - URL string and object input
 * - Default pageType resolution
 * - Null normalization for optional fields
 */

import { describe, it, expect } from "vitest";

import { createPublicPageContext } from "../../../src/page/context.js";

describe("createPublicPageContext", () => {
	it("accepts Astro-like input and extracts url/path/locale", () => {
		const result = createPublicPageContext({
			Astro: {
				url: new URL("https://example.com/blog/hello"),
				currentLocale: "en",
			},
			kind: "content",
			title: "Hello",
			pageTitle: "Hello",
		});

		expect(result.url).toBe("https://example.com/blog/hello");
		expect(result.path).toBe("/blog/hello");
		expect(result.locale).toBe("en");
		expect(result.title).toBe("Hello");
		expect(result.pageTitle).toBe("Hello");
	});

	it("accepts URL string input", () => {
		const result = createPublicPageContext({
			url: "https://example.com/about",
			kind: "custom",
			locale: "fr",
		});

		expect(result.url).toBe("https://example.com/about");
		expect(result.path).toBe("/about");
		expect(result.locale).toBe("fr");
	});

	it("accepts URL object input", () => {
		const urlObj = new URL("https://example.com/products?page=2");

		const result = createPublicPageContext({
			url: urlObj,
			kind: "custom",
		});

		expect(result.url).toBe("https://example.com/products?page=2");
		expect(result.path).toBe("/products");
	});

	it('defaults pageType to "article" for content kind', () => {
		const result = createPublicPageContext({
			url: "https://example.com/post/1",
			kind: "content",
		});

		expect(result.pageType).toBe("article");
	});

	it('defaults pageType to "website" for custom kind', () => {
		const result = createPublicPageContext({
			url: "https://example.com/",
			kind: "custom",
		});

		expect(result.pageType).toBe("website");
	});

	it("normalizes undefined locale to null", () => {
		const result = createPublicPageContext({
			Astro: {
				url: new URL("https://example.com/"),
				// currentLocale not set
			},
			kind: "custom",
		});

		expect(result.locale).toBeNull();
	});

	it("normalizes undefined pageTitle to null", () => {
		const result = createPublicPageContext({
			url: "https://example.com/about",
			kind: "custom",
			title: "About | My Site",
		});

		expect(result.pageTitle).toBeNull();
	});

	it("normalizes content slug undefined to null", () => {
		const result = createPublicPageContext({
			url: "https://example.com/post/1",
			kind: "content",
			content: { collection: "posts", id: "abc123" },
		});

		expect(result.content).toBeDefined();
		expect(result.content!.slug).toBeNull();
		expect(result.content!.collection).toBe("posts");
		expect(result.content!.id).toBe("abc123");
	});

	it("sets content to undefined for custom kind", () => {
		const result = createPublicPageContext({
			url: "https://example.com/about",
			kind: "custom",
		});

		expect(result.content).toBeUndefined();
	});
});
