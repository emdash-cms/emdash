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

	it("reads the exporter's GMT date as UTC regardless of the server time zone", async () => {
		vi.stubEnv("TZ", "Europe/Zurich");
		try {
			mockFetch.mockResolvedValueOnce(
				contentResponse([
					makePost({ date: "2099-06-01 11:30:00", date_gmt: "2099-06-01 09:30:00" }),
					makePost({ id: 2, date: "2099-06-01 11:30:00", date_gmt: "0000-00-00 00:00:00" }),
				]),
			);

			const items = [];
			for await (const item of wordpressPluginSource.fetchContent(
				{ type: "url", url: "https://example.com", token: "test-token" },
				{ postTypes: ["post"] },
			)) {
				items.push(item);
			}

			expect(items[0]!.date.toISOString()).toBe("2099-06-01T09:30:00.000Z");
			expect(items[1]!.date.toISOString()).toBe(new Date("2099-06-01T11:30:00").toISOString());
		} finally {
			vi.unstubAllEnvs();
		}
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

	it("suggests every field of the ACF field groups assigned to a post type", async () => {
		const field = (name: string, type: string) => ({
			key: `field_${name}`,
			name,
			label: name,
			type,
			required: false,
		});
		const postTypeRule = (value: string, operator = "==") => [
			[{ param: "post_type", operator, value }],
		];
		const analyzeResponse = {
			...makeAnalyzeResponse(0),
			post_types: [
				{
					name: "post",
					label: "Posts",
					label_singular: "Post",
					total: 2,
					by_status: { publish: 2 },
					supports: {},
					taxonomies: [],
					custom_fields: [
						{ key: "subtitle", count: 2, inferred_type: "string", sample: "A subtitle" },
						{ key: "credits", count: 2, inferred_type: "integer", sample: "2" },
						{ key: "credits_0_credit_name", count: 2, inferred_type: "string", sample: "Ada" },
						{ key: "credits_0_credit_role", count: 2, inferred_type: "string", sample: "Author" },
						{ key: "credits_note", count: 2, inferred_type: "string", sample: "Reprint" },
						{ key: "sections_0_heading", count: 2, inferred_type: "string", sample: "Intro" },
						{ key: "authors_0_name", count: 2, inferred_type: "string", sample: "Ada" },
						{ key: "publisher_name", count: 2, inferred_type: "string", sample: "Acme" },
					],
					hierarchical: false,
					has_archive: false,
				},
			],
			acf: [
				{
					key: "group_book",
					title: "Book details",
					location: postTypeRule("post"),
					fields: [
						field("subtitle", "text"),
						field("blurb", "textarea"),
						field("rating", "number"),
						field("featured", "true_false"),
						field("genres", "checkbox"),
						field("related", "relationship"),
						field("credits", "repeater"),
						field("sections", "flexible_content"),
						field("publisher", "group"),
						field("details", "tab"),
					],
				},
				{
					key: "group_page",
					title: "Page details",
					location: postTypeRule("page"),
					fields: [field("hero_text", "text")],
				},
				{
					key: "group_not_post",
					title: "Everything but posts",
					location: postTypeRule("post", "!="),
					fields: [field("banner_text", "text")],
				},
			],
		};
		mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(analyzeResponse), { status: 200 }));

		const analysis = await wordpressPluginSource.analyze(
			{ type: "url", url: "https://example.com", token: "test-token" },
			{},
		);

		const custom = analysis.postTypes[0]!.requiredFields.filter(
			(f) => !["title", "content", "excerpt", "featured_image"].includes(f.slug),
		);
		expect(Object.fromEntries(custom.map((f) => [f.slug, f.type]))).toEqual({
			subtitle: "string",
			blurb: "text",
			rating: "number",
			featured: "boolean",
			genres: "json",
			related: "json",
			credits: "json",
			sections: "json",
			publisher: "json",
			credits_note: "string",
			authors_0_name: "string",
			publisher_name: "string",
		});
	});

	describe("ACF fields in a collection that already exists", () => {
		const acfGroup = (fields: Array<{ name: string; type: string }>) => [
			{
				key: "group_book",
				title: "Book details",
				location: [[{ param: "post_type", operator: "==", value: "post" }]],
				fields: fields.map((f) => ({
					key: `field_${f.name}`,
					label: f.name,
					required: false,
					...f,
				})),
			},
		];
		const analyzeWith = async (
			acf: ReturnType<typeof acfGroup>,
			customFields: Array<{ key: string; inferred_type: string }>,
			existingFields: Record<string, string>,
		) => {
			const analyzeResponse = {
				...makeAnalyzeResponse(0),
				post_types: [
					{
						name: "post",
						label: "Posts",
						label_singular: "Post",
						total: 2,
						by_status: { publish: 2 },
						supports: {},
						taxonomies: [],
						custom_fields: customFields.map((f) => ({ ...f, count: 2, sample: "x" })),
						hierarchical: false,
						has_archive: false,
					},
				],
				acf,
			};
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify(analyzeResponse), { status: 200 }),
			);
			const fields = new Map(
				Object.entries(existingFields).map(([slug, type]) => [slug, { type }]),
			);
			const analysis = await wordpressPluginSource.analyze(
				{ type: "url", url: "https://example.com", token: "test-token" },
				{ getExistingCollections: async () => new Map([["posts", { slug: "posts", fields }]]) },
			);
			return analysis.postTypes[0]!;
		};

		it("keeps the fields an earlier import created from the raw meta", async () => {
			const postType = await analyzeWith(
				acfGroup([
					{ name: "featured", type: "true_false" },
					{ name: "credits", type: "repeater" },
				]),
				[
					{ key: "featured", inferred_type: "integer" },
					{ key: "credits", inferred_type: "integer" },
					{ key: "credits_0_credit_name", inferred_type: "string" },
					{ key: "credits_1_credit_name", inferred_type: "string" },
				],
				{
					title: "string",
					featured: "integer",
					credits: "integer",
					credits_0_credit_name: "string",
				},
			);

			expect(postType.schemaStatus.canImport).toBe(true);
			const types = new Map(postType.requiredFields.map((f) => [f.slug, f.type]));
			expect(types.get("featured")).toBe("integer");
			expect(types.get("credits")).toBe("integer");
			expect(types.get("credits_1_credit_name")).toBe("string");
		});

		const rawMeta: Array<[string, Array<{ key: string; inferred_type: string }>]> = [
			["without", []],
			["with", [{ key: "rating", inferred_type: "integer" }]],
		];
		it.each(rawMeta)(
			"reports an ACF field whose type conflicts with a field the site defined, %s raw meta",
			async (_label, customFields) => {
				const postType = await analyzeWith(
					acfGroup([{ name: "rating", type: "number" }]),
					customFields,
					{ title: "string", rating: "boolean" },
				);

				expect(postType.schemaStatus.canImport).toBe(false);
				expect(postType.schemaStatus.fieldStatus.rating?.status).toBe("type_mismatch");
			},
		);
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
