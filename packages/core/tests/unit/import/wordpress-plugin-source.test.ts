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

function toUrlString(input: RequestInfo | URL): string {
	return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

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

	it("surfaces custom fields (ACF/meta) as suggested fields with sanitized slugs", async () => {
		const analyzeResponse = {
			...makeAnalyzeResponse(0),
			post_types: [
				{
					name: "event",
					label: "Events",
					label_singular: "Event",
					total: 3,
					by_status: { publish: 3 },
					supports: {},
					taxonomies: [],
					custom_fields: [
						{ key: "event-start_date", count: 3, inferred_type: "datetime", sample: "2026-01-01" },
						{ key: "Ticket Price", count: 3, inferred_type: "number", sample: "25.50" },
						{ key: "venue", count: 2, inferred_type: "weird_type", sample: "Hall A" },
						// Collides with a base field -- must not be duplicated
						{ key: "title", count: 3, inferred_type: "string", sample: "x" },
						// Plugin bookkeeping -- must not be suggested as content fields
						{ key: "wpil_sync_report3", count: 3, inferred_type: "integer", sample: "1" },
						{ key: "rank_math_seo_score", count: 3, inferred_type: "integer", sample: "80" },
						{ key: "entity_same_as", count: 2, inferred_type: "string", sample: "https://x" },
						// Hyphenated variant must be caught too
						{ key: "ampforwp-amp-on-off", count: 3, inferred_type: "string", sample: "default" },
					],
					hierarchical: false,
					has_archive: true,
				},
			],
		};
		mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(analyzeResponse), { status: 200 }));

		const analysis = await wordpressPluginSource.analyze(
			{ type: "url", url: "https://example.com", token: "test-token" },
			{},
		);

		const fields = analysis.postTypes[0]!.requiredFields;
		const bySlug = new Map(fields.map((f) => [f.slug, f]));
		expect(bySlug.get("event_start_date")).toMatchObject({ type: "datetime", required: false });
		expect(bySlug.get("ticket_price")).toMatchObject({ type: "number", label: "Ticket Price" });
		// Unknown inferred types fall back to string
		expect(bySlug.get("venue")).toMatchObject({ type: "string" });
		// Base fields are not duplicated
		expect(fields.filter((f) => f.slug === "title")).toHaveLength(1);
		// Plugin bookkeeping meta is filtered out
		expect(bySlug.has("wpil_sync_report3")).toBe(false);
		expect(bySlug.has("rank_math_seo_score")).toBe(false);
		expect(bySlug.has("entity_same_as")).toBe(false);
		expect(bySlug.has("ampforwp_amp_on_off")).toBe(false);
	});

	it("fetches every media page during analyze, not just the first", async () => {
		mockFetch.mockImplementation((input: RequestInfo | URL) => {
			const url = toUrlString(input);
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
			const url = toUrlString(input);
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
