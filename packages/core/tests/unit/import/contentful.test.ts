/**
 * Tests for the Contentful import mapper modules.
 *
 * Pure function tests — no database required.
 */

import type { ContentfulIncludes } from "@emdash-cms/contentful-to-portable-text";
import { describe, it, expect } from "vitest";

import { mapAuthor } from "../../../src/import/contentful/map-author.js";
import { flattenLocaleList } from "../../../src/import/contentful/map-locale-list.js";
import { mapPost } from "../../../src/import/contentful/map-post.js";
import { mapTag } from "../../../src/import/contentful/map-tag.js";
import { parseContentfulExport } from "../../../src/import/contentful/parse-export.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function emptyIncludes(): ContentfulIncludes {
	return { entries: new Map(), assets: new Map() };
}

// ── mapTag ──────────────────────────────────────────────────────────────────

describe("mapTag", () => {
	it("extracts label and slug from blogTag entry", () => {
		const result = mapTag({
			fields: { name: "Engineering", slug: "engineering" },
		});
		expect(result).toEqual({
			label: "Engineering",
			slug: "engineering",
		});
	});

	it("defaults to empty strings for missing fields", () => {
		const result = mapTag({ fields: {} });
		expect(result.label).toBe("");
		expect(result.slug).toBe("");
	});
});

// ── mapAuthor ───────────────────────────────────────────────────────────────

describe("mapAuthor", () => {
	it("maps blogAuthor fields to author shape", () => {
		const result = mapAuthor(
			{
				sys: { id: "author-1" },
				fields: {
					name: "Jane Engineer",
					slug: "jane-engineer",
					bio: "Writes about systems.",
					jobTitle: "Staff Engineer",
				},
			},
			emptyIncludes(),
		);

		expect(result.slug).toBe("jane-engineer");
		expect(result.data.name).toBe("Jane Engineer");
		expect(result.data.bio).toBe("Writes about systems.");
		expect(result.data.job_title).toBe("Staff Engineer");
		expect(result.data.profile_image).toBeNull();
	});

	it("resolves profile image from includes", () => {
		const includes = emptyIncludes();
		includes.assets.set("asset-1", {
			id: "asset-1",
			url: "//images.ctfassets.net/photo.jpg",
			title: "Photo",
			description: "Author photo",
			width: 200,
			height: 200,
		});

		const result = mapAuthor(
			{
				sys: { id: "author-2" },
				fields: {
					name: "Alex",
					slug: "alex",
					profileImage: { sys: { id: "asset-1" } },
				},
			},
			includes,
		);

		expect(result.data.profile_image).toEqual({
			src: "https://images.ctfassets.net/photo.jpg",
			alt: "Author photo",
		});
	});
});

// ── mapPost ─────────────────────────────────────────────────────────────────

describe("mapPost", () => {
	it("maps basic blogPost fields", () => {
		const includes = emptyIncludes();
		const result = mapPost(
			{
				sys: { id: "post-1", createdAt: "2025-06-10T12:00:00.000Z" },
				fields: {
					title: "  My Post  ",
					slug: " my-post ",
					excerpt: "A test post",
					featured: true,
					publishDate: "2025-06-15T00:00+01:00",
				},
			},
			includes,
		);

		expect(result.slug).toBe("my-post");
		expect(result.data.title).toBe("My Post");
		expect(result.data.excerpt).toBe("A test post");
		expect(result.data.featured).toBe(true);
		expect(result.publishDate).toBe("2025-06-15T00:00+01:00");
		expect(result.createdAt).toBe("2025-06-10T12:00:00.000Z");
	});

	it("resolves tag slugs from entry links", () => {
		const includes = emptyIncludes();
		includes.entries.set("tag-1", {
			id: "tag-1",
			contentType: "blogTag",
			fields: { name: "Engineering", slug: "engineering" },
		});
		includes.entries.set("tag-2", {
			id: "tag-2",
			contentType: "blogTag",
			fields: { name: "Performance", slug: "performance" },
		});

		const result = mapPost(
			{
				sys: { id: "post-1", createdAt: "2025-01-01T00:00:00Z" },
				fields: {
					title: "Test",
					slug: "test",
					tags: [{ sys: { id: "tag-1" } }, { sys: { id: "tag-2" } }],
				},
			},
			includes,
		);

		expect(result.tagSlugs).toEqual(["engineering", "performance"]);
	});

	it("resolves author slugs from entry links (both 'author' and 'authors' field names)", () => {
		const includes = emptyIncludes();
		includes.entries.set("author-1", {
			id: "author-1",
			contentType: "blogAuthor",
			fields: { name: "Jane", slug: "jane" },
		});

		// Test "author" field name
		const result1 = mapPost(
			{
				sys: { id: "post-1", createdAt: "2025-01-01T00:00:00Z" },
				fields: {
					title: "Test",
					slug: "test",
					author: [{ sys: { id: "author-1" } }],
				},
			},
			includes,
		);
		expect(result1.authorSlugs).toEqual(["jane"]);

		// Test "authors" field name
		const result2 = mapPost(
			{
				sys: { id: "post-2", createdAt: "2025-01-01T00:00:00Z" },
				fields: {
					title: "Test 2",
					slug: "test-2",
					authors: [{ sys: { id: "author-1" } }],
				},
			},
			includes,
		);
		expect(result2.authorSlugs).toEqual(["jane"]);
	});

	it("handles singular (non-array) tag and author references", () => {
		const includes = emptyIncludes();
		includes.entries.set("tag-1", {
			id: "tag-1",
			contentType: "blogTag",
			fields: { name: "Solo Tag", slug: "solo-tag" },
		});
		includes.entries.set("author-1", {
			id: "author-1",
			contentType: "blogAuthor",
			fields: { name: "Solo Author", slug: "solo-author" },
		});

		const result = mapPost(
			{
				sys: { id: "post-1", createdAt: "2025-01-01T00:00:00Z" },
				fields: {
					title: "Test",
					slug: "test",
					tag: { sys: { id: "tag-1" } },
					author: { sys: { id: "author-1" } },
				},
			},
			includes,
		);

		expect(result.tagSlugs).toEqual(["solo-tag"]);
		expect(result.authorSlugs).toEqual(["solo-author"]);
	});

	it("resolves featured image from asset link", () => {
		const includes = emptyIncludes();
		includes.assets.set("asset-1", {
			id: "asset-1",
			url: "//images.ctfassets.net/hero.jpg",
			description: "Hero image",
			width: 1200,
			height: 800,
		});

		const result = mapPost(
			{
				sys: { id: "post-1", createdAt: "2025-01-01T00:00:00Z" },
				fields: {
					title: "Test",
					slug: "test",
					featureImage: { sys: { id: "asset-1" } },
				},
			},
			includes,
		);

		expect(result.data.featured_image).toEqual({
			src: "https://images.ctfassets.net/hero.jpg",
			alt: "Hero image",
		});
	});

	it("resolves locale_list from configLocaleList entry link", () => {
		const includes = emptyIncludes();
		includes.entries.set("locale-1", {
			id: "locale-1",
			contentType: "configLocaleList",
			fields: {
				name: "Default",
				enUs: "Translated for Locale",
				deDe: "No Page for Locale",
			},
		});

		const result = mapPost(
			{
				sys: { id: "post-1", createdAt: "2025-01-01T00:00:00Z" },
				fields: {
					title: "Test",
					slug: "test",
					localeList: { sys: { id: "locale-1" } },
				},
			},
			includes,
		);

		expect(result.data.locale_list).toEqual({
			"en-us": "Translated for Locale",
			"de-de": "No Page for Locale",
		});
	});

	it("maps SEO fields", () => {
		const result = mapPost(
			{
				sys: { id: "post-1", createdAt: "2025-01-01T00:00:00Z" },
				fields: {
					title: "Test",
					slug: "test",
					metaDescription: "SEO description",
					publiclyIndex: false,
				},
			},
			emptyIncludes(),
		);

		expect(result.seo).toEqual({
			description: "SEO description",
			noIndex: true,
		});
	});

	it("converts rich text content to Portable Text", () => {
		const includes = emptyIncludes();
		const result = mapPost(
			{
				sys: { id: "post-1", createdAt: "2025-01-01T00:00:00Z" },
				fields: {
					title: "Test",
					slug: "test",
					content: {
						nodeType: "document",
						data: {},
						content: [
							{
								nodeType: "paragraph",
								data: {},
								content: [
									{
										nodeType: "text",
										value: "Hello world",
										marks: [],
										data: {},
									},
								],
							},
						],
					},
				},
			},
			includes,
		);

		const content = result.data.content as Array<{ _type: string }>;
		expect(content).toHaveLength(1);
		expect(content[0]!._type).toBe("block");
	});
});

// ── flattenLocaleList ───────────────────────────────────────────────────────

describe("flattenLocaleList", () => {
	it("converts camelCase keys to hyphenated locale codes", () => {
		const result = flattenLocaleList({
			name: "Default",
			enUs: "Translated for Locale",
			deDe: "No Page for Locale",
			frFr: "Translated for Locale",
			jaJp: "No Page for Locale",
		});

		expect(result).toEqual({
			"en-us": "Translated for Locale",
			"de-de": "No Page for Locale",
			"fr-fr": "Translated for Locale",
			"ja-jp": "No Page for Locale",
		});
	});

	it("skips the name field", () => {
		const result = flattenLocaleList({ name: "Config Name" });
		expect(result).toEqual({});
	});

	it("skips non-string values", () => {
		const result = flattenLocaleList({
			name: "Config",
			enUs: "Valid",
			someNumber: 42,
			someBoolean: true,
		});
		expect(result).toEqual({ "en-us": "Valid" });
	});
});

// ── parseContentfulExport ───────────────────────────────────────────────────

describe("parseContentfulExport", () => {
	it("groups items by content type", () => {
		const parsed = parseContentfulExport({
			items: [
				{
					sys: {
						id: "post-1",
						type: "Entry",
						createdAt: "2025-01-01T00:00:00Z",
						updatedAt: "2025-01-01T00:00:00Z",
						contentType: {
							sys: { id: "blogPost" },
						},
					},
					fields: { title: "Post 1" },
				},
				{
					sys: {
						id: "tag-1",
						type: "Entry",
						createdAt: "2025-01-01T00:00:00Z",
						updatedAt: "2025-01-01T00:00:00Z",
						contentType: {
							sys: { id: "blogTag" },
						},
					},
					fields: { name: "Tag 1", slug: "tag-1" },
				},
				{
					sys: {
						id: "post-2",
						type: "Entry",
						createdAt: "2025-01-01T00:00:00Z",
						updatedAt: "2025-01-01T00:00:00Z",
						contentType: {
							sys: { id: "blogPost" },
						},
					},
					fields: { title: "Post 2" },
				},
			],
			includes: {
				Asset: [],
			},
		});

		expect(parsed.byType.get("blogPost")).toHaveLength(2);
		expect(parsed.byType.get("blogTag")).toHaveLength(1);
		expect(parsed.counts).toEqual({ blogPost: 2, blogTag: 1 });
	});

	it("merges items into includes entries map for cross-reference", () => {
		const parsed = parseContentfulExport({
			items: [
				{
					sys: {
						id: "code-1",
						type: "Entry",
						createdAt: "2025-01-01T00:00:00Z",
						updatedAt: "2025-01-01T00:00:00Z",
						contentType: {
							sys: { id: "blogCodeBlock" },
						},
					},
					fields: { code: "hello", language: "js" },
				},
			],
			includes: {},
		});

		// Items should be in the includes entries map
		const entry = parsed.includes.entries.get("code-1");
		expect(entry).toBeDefined();
		expect(entry!.contentType).toBe("blogCodeBlock");
		expect(entry!.fields.code).toBe("hello");
	});

	it("resolves assets from includes.Asset", () => {
		const parsed = parseContentfulExport({
			items: [],
			includes: {
				Asset: [
					{
						sys: { id: "asset-1" },
						fields: {
							title: "Photo",
							file: {
								url: "//images.ctfassets.net/photo.jpg",
								details: { image: { width: 800, height: 600 } },
								contentType: "image/jpeg",
							},
						},
					},
				],
			},
		});

		const asset = parsed.includes.assets.get("asset-1");
		expect(asset).toBeDefined();
		expect(asset!.url).toBe("//images.ctfassets.net/photo.jpg");
		expect(asset!.width).toBe(800);
	});

	it("handles empty export", () => {
		const parsed = parseContentfulExport({});
		expect(parsed.byType.size).toBe(0);
		expect(parsed.includes.entries.size).toBe(0);
		expect(parsed.includes.assets.size).toBe(0);
	});
});
