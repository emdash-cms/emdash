/**
 * Tests for WordPress plugin import source fetch behaviour:
 * - custom taxonomy assignments on normalized items
 * - full media pagination in analyze() (regression: only page 1 was fetched)
 * - ?rest_route= fallback for sites with plain permalinks
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { wordpressPluginSource } from "../../../src/import/sources/wordpress-plugin.js";
import { setDefaultDnsResolver } from "../../../src/import/ssrf.js";

// ─── Mock fetch ──────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Bypass DoH so the fetch mock only sees the calls these tests model.
let previousResolver: ReturnType<typeof setDefaultDnsResolver> | undefined;
beforeAll(() => {
	previousResolver = setDefaultDnsResolver(async () => ["93.184.216.34"]);
});
afterAll(() => {
	setDefaultDnsResolver(previousResolver ?? null);
});

beforeEach(() => {
	mockFetch.mockReset();
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makePost(overrides: Record<string, unknown> = {}) {
	return {
		id: 1,
		post_type: "post",
		status: "publish",
		slug: "hello",
		title: "Hello",
		content: "",
		excerpt: "",
		date: "2024-01-01T00:00:00",
		date_gmt: "2024-01-01T00:00:00",
		modified: "2024-01-01T00:00:00",
		modified_gmt: "2024-01-01T00:00:00",
		author: null,
		parent: null,
		menu_order: 0,
		taxonomies: {},
		meta: {},
		...overrides,
	};
}

function contentResponse(items: unknown[]) {
	return new Response(
		JSON.stringify({ items, total: items.length, pages: 1, page: 1, per_page: 100 }),
		{ status: 200 },
	);
}

function makeAnalyzeResponse(attachmentCount: number) {
	return {
		site: { title: "Test Site", url: "https://example.com" },
		post_types: [],
		taxonomies: [],
		authors: [],
		attachments: { count: attachmentCount, by_type: {} },
	};
}

function mediaPage(page: number, pages: number, ids: number[]) {
	return new Response(
		JSON.stringify({
			items: ids.map((id) => ({
				id,
				url: `https://example.com/wp-content/uploads/${id}.jpg`,
				filename: `${id}.jpg`,
				mime_type: "image/jpeg",
				title: `Image ${id}`,
				alt: "",
				caption: "",
				description: "",
			})),
			total: ids.length * pages,
			pages,
			page,
			per_page: 500,
		}),
		{ status: 200 },
	);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("WordPress Plugin Source — fetch behaviour", () => {
	it("maps non-category/tag taxonomies to customTaxonomies", async () => {
		mockFetch.mockResolvedValueOnce(
			contentResponse([
				makePost({
					taxonomies: {
						category: [{ id: 1, name: "News", slug: "news" }],
						post_tag: [{ id: 2, name: "Update", slug: "update" }],
						genre: [
							{ id: 3, name: "Sci-Fi", slug: "sci-fi" },
							{ id: 4, name: "Fantasy", slug: "fantasy" },
						],
					},
				}),
			]),
		);

		const items = [];
		for await (const item of wordpressPluginSource.fetchContent(
			{ type: "url", url: "https://example.com", token: "test-token" },
			{ postTypes: ["post"] },
		)) {
			items.push(item);
		}

		expect(items).toHaveLength(1);
		expect(items[0]!.categories).toEqual(["news"]);
		expect(items[0]!.tags).toEqual(["update"]);
		expect(items[0]!.customTaxonomies).toEqual({ genre: ["sci-fi", "fantasy"] });
	});

	it("fetches every media page during analyze, not just the first", async () => {
		mockFetch.mockImplementation((input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/analyze")) {
				return Promise.resolve(
					new Response(JSON.stringify(makeAnalyzeResponse(3)), { status: 200 }),
				);
			}
			if (url.includes("page=2")) {
				return Promise.resolve(mediaPage(2, 2, [3]));
			}
			return Promise.resolve(mediaPage(1, 2, [1, 2]));
		});

		const analysis = await wordpressPluginSource.analyze(
			{ type: "url", url: "https://example.com", token: "test-token" },
			{},
		);

		expect(analysis.attachments.items.map((a) => a.id)).toEqual([1, 2, 3]);
	});

	it("falls back to ?rest_route= when the pretty route 404s (plain permalinks)", async () => {
		mockFetch.mockImplementation((input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/wp-json/")) {
				return Promise.resolve(new Response("Not Found", { status: 404 }));
			}
			if (url.includes("rest_route=")) {
				return Promise.resolve(contentResponse([makePost()]));
			}
			return Promise.resolve(new Response("Unexpected", { status: 500 }));
		});

		const items = [];
		for await (const item of wordpressPluginSource.fetchContent(
			{ type: "url", url: "https://example.com", token: "test-token" },
			{ postTypes: ["post"] },
		)) {
			items.push(item);
		}

		expect(items).toHaveLength(1);
		expect(items[0]!.slug).toBe("hello");
	});
});
