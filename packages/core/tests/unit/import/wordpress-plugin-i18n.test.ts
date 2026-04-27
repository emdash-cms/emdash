/**
 * Tests for WPML/Polylang auto-detection in WordPress plugin import source.
 *
 * Verifies that the probe() and analyze() methods correctly extract and
 * surface i18n detection from the EmDash Exporter plugin's API responses.
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

/** Minimal valid probe response without i18n */
function makeProbeResponse(overrides: Record<string, unknown> = {}) {
	return {
		emdash_exporter: "1.0.0",
		wordpress_version: "6.5",
		site: {
			title: "Test Site",
			description: "A test site",
			url: "https://example.com",
			home: "https://example.com",
			language: "en-US",
			timezone: "UTC",
		},
		capabilities: {
			application_passwords: true,
			acf: false,
			yoast: false,
			rankmath: false,
		},
		post_types: [
			{ name: "post", label: "Posts", count: 10 },
			{ name: "page", label: "Pages", count: 5 },
		],
		media_count: 20,
		endpoints: {},
		auth_instructions: {
			method: "application_passwords",
			instructions: "Create an application password",
		},
		...overrides,
	};
}

/** Minimal valid analyze response without i18n */
function makeAnalyzeResponse(overrides: Record<string, unknown> = {}) {
	return {
		site: { title: "Test Site", url: "https://example.com" },
		post_types: [
			{
				name: "post",
				label: "Posts",
				label_singular: "Post",
				total: 10,
				by_status: { publish: 8, draft: 2 },
				supports: { title: true, editor: true, thumbnail: true },
				taxonomies: ["category", "post_tag"],
				custom_fields: [],
				hierarchical: false,
				has_archive: true,
			},
		],
		taxonomies: [
			{
				name: "category",
				label: "Categories",
				hierarchical: true,
				term_count: 5,
				object_types: ["post"],
			},
			{
				name: "post_tag",
				label: "Tags",
				hierarchical: false,
				term_count: 12,
				object_types: ["post"],
			},
		],
		authors: [
			{ id: 1, login: "admin", email: "admin@example.com", display_name: "Admin", post_count: 10 },
		],
		attachments: { count: 20, by_type: { "image/jpeg": 15, "image/png": 5 } },
		...overrides,
	};
}

// ─── Probe tests ─────────────────────────────────────────────────────────────

describe("WordPress Plugin Source — i18n detection", () => {
	describe("probe()", () => {
		it("returns i18n when WPML is detected", async () => {
			mockFetch.mockResolvedValueOnce(
				new Response(
					JSON.stringify(
						makeProbeResponse({
							i18n: {
								plugin: "wpml",
								default_locale: "en",
								locales: ["en", "fr", "de"],
							},
						}),
					),
					{ status: 200 },
				),
			);

			const result = await wordpressPluginSource.probe!("https://example.com");

			expect(result).not.toBeNull();
			expect(result!.i18n).toEqual({
				plugin: "wpml",
				defaultLocale: "en",
				locales: ["en", "fr", "de"],
			});
		});

		it("returns i18n when Polylang is detected", async () => {
			mockFetch.mockResolvedValueOnce(
				new Response(
					JSON.stringify(
						makeProbeResponse({
							i18n: {
								plugin: "polylang",
								default_locale: "fr",
								locales: ["fr", "en"],
							},
						}),
					),
					{ status: 200 },
				),
			);

			const result = await wordpressPluginSource.probe!("https://example.com");

			expect(result).not.toBeNull();
			expect(result!.i18n).toEqual({
				plugin: "polylang",
				defaultLocale: "fr",
				locales: ["fr", "en"],
			});
		});

		it("returns undefined i18n when no multilingual plugin", async () => {
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify(makeProbeResponse()), { status: 200 }),
			);

			const result = await wordpressPluginSource.probe!("https://example.com");

			expect(result).not.toBeNull();
			expect(result!.i18n).toBeUndefined();
		});

		it("preserves other probe fields alongside i18n", async () => {
			mockFetch.mockResolvedValueOnce(
				new Response(
					JSON.stringify(
						makeProbeResponse({
							i18n: {
								plugin: "wpml",
								default_locale: "en",
								locales: ["en", "es"],
							},
						}),
					),
					{ status: 200 },
				),
			);

			const result = await wordpressPluginSource.probe!("https://example.com");

			expect(result).not.toBeNull();
			expect(result!.sourceId).toBe("wordpress-plugin");
			expect(result!.confidence).toBe("definite");
			expect(result!.detected.platform).toBe("wordpress");
			expect(result!.preview?.posts).toBe(10);
			expect(result!.i18n?.plugin).toBe("wpml");
		});
	});

	// ─── Analyze tests ───────────────────────────────────────────────────────

	describe("analyze()", () => {
		it("returns i18n when WPML is detected", async () => {
			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes("/analyze")) {
					return new Response(
						JSON.stringify(
							makeAnalyzeResponse({
								i18n: {
									plugin: "wpml",
									default_locale: "en",
									locales: ["en", "fr", "de"],
								},
							}),
						),
						{ status: 200 },
					);
				}
				// Media endpoint — return empty
				return new Response(
					JSON.stringify({ items: [], total: 0, pages: 0, page: 1, per_page: 100 }),
					{ status: 200 },
				);
			});

			const analysis = await wordpressPluginSource.analyze(
				{ type: "url", url: "https://example.com", token: "test-token" },
				{},
			);

			expect(analysis.i18n).toEqual({
				plugin: "wpml",
				defaultLocale: "en",
				locales: ["en", "fr", "de"],
			});
		});

		it("returns i18n when Polylang is detected", async () => {
			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes("/analyze")) {
					return new Response(
						JSON.stringify(
							makeAnalyzeResponse({
								i18n: {
									plugin: "polylang",
									default_locale: "fr",
									locales: ["fr", "en", "de"],
								},
							}),
						),
						{ status: 200 },
					);
				}
				return new Response(
					JSON.stringify({ items: [], total: 0, pages: 0, page: 1, per_page: 100 }),
					{ status: 200 },
				);
			});

			const analysis = await wordpressPluginSource.analyze(
				{ type: "url", url: "https://example.com", token: "test-token" },
				{},
			);

			expect(analysis.i18n).toEqual({
				plugin: "polylang",
				defaultLocale: "fr",
				locales: ["fr", "en", "de"],
			});
		});

		it("returns undefined i18n when no multilingual plugin", async () => {
			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes("/analyze")) {
					return new Response(JSON.stringify(makeAnalyzeResponse()), { status: 200 });
				}
				return new Response(
					JSON.stringify({ items: [], total: 0, pages: 0, page: 1, per_page: 100 }),
					{ status: 200 },
				);
			});

			const analysis = await wordpressPluginSource.analyze(
				{ type: "url", url: "https://example.com", token: "test-token" },
				{},
			);

			expect(analysis.i18n).toBeUndefined();
		});
	});

	// ─── Content fetch — locale/translationGroup passthrough ─────────────────

	describe("fetchContent()", () => {
		it("passes through locale and translationGroup from plugin posts", async () => {
			mockFetch.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [
							{
								id: 1,
								post_type: "post",
								status: "publish",
								slug: "hello-world",
								title: "Hello World",
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
								locale: "en",
								translation_group: "group-1",
							},
							{
								id: 2,
								post_type: "post",
								status: "publish",
								slug: "bonjour-le-monde",
								title: "Bonjour le monde",
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
								locale: "fr",
								translation_group: "group-1",
							},
						],
						total: 2,
						pages: 1,
						page: 1,
						per_page: 100,
					}),
					{ status: 200 },
				),
			);

			const items = [];
			for await (const item of wordpressPluginSource.fetchContent(
				{ type: "url", url: "https://example.com", token: "test-token" },
				{ postTypes: ["post"] },
			)) {
				items.push(item);
			}

			expect(items).toHaveLength(2);
			expect(items[0]!.locale).toBe("en");
			expect(items[0]!.translationGroup).toBe("group-1");
			expect(items[1]!.locale).toBe("fr");
			expect(items[1]!.translationGroup).toBe("group-1");
		});

		it("returns undefined locale/translationGroup when not present", async () => {
			mockFetch.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [
							{
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
							},
						],
						total: 1,
						pages: 1,
						page: 1,
						per_page: 100,
					}),
					{ status: 200 },
				),
			);

			const items = [];
			for await (const item of wordpressPluginSource.fetchContent(
				{ type: "url", url: "https://example.com", token: "test-token" },
				{ postTypes: ["post"] },
			)) {
				items.push(item);
			}

			expect(items).toHaveLength(1);
			expect(items[0]!.locale).toBeUndefined();
			expect(items[0]!.translationGroup).toBeUndefined();
		});
	});
});
