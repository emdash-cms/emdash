import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { createComponent as createPage } from "astro/runtime/server/index.js";
import { beforeEach, describe, expect, test, vi } from "vitest";

import CloudflareDemoCategory from "../../../../demos/cloudflare/src/pages/category/[slug].astro";
import CloudflareDemoTag from "../../../../demos/cloudflare/src/pages/tag/[slug].astro";
import PlaygroundCategory from "../../../../demos/playground/src/pages/category/[slug].astro";
import PlaygroundTag from "../../../../demos/playground/src/pages/tag/[slug].astro";
import PostgresCategory from "../../../../demos/postgres/src/pages/category/[slug].astro";
import PostgresTag from "../../../../demos/postgres/src/pages/tag/[slug].astro";
import PreviewCategory from "../../../../demos/preview/src/pages/category/[slug].astro";
import PreviewTag from "../../../../demos/preview/src/pages/tag/[slug].astro";
import SimpleCategory from "../../../../demos/simple/src/pages/category/[slug].astro";
import SimpleTag from "../../../../demos/simple/src/pages/tag/[slug].astro";
import CloudflareBlogCategory from "../../../../templates/blog-cloudflare/src/pages/category/[slug].astro";
import CloudflareBlogTag from "../../../../templates/blog-cloudflare/src/pages/tag/[slug].astro";
import BlogCategory from "../../../../templates/blog/src/pages/category/[slug].astro";
import BlogTag from "../../../../templates/blog/src/pages/tag/[slug].astro";
import CloudflareStarterCategory from "../../../../templates/starter-cloudflare/src/pages/category/[slug].astro";
import CloudflareStarterTag from "../../../../templates/starter-cloudflare/src/pages/tag/[slug].astro";
import StarterCategory from "../../../../templates/starter/src/pages/category/[slug].astro";
import StarterTag from "../../../../templates/starter/src/pages/tag/[slug].astro";

const state = vi.hoisted(() => ({
	terms: [] as Array<{ slug: string; label: string }>,
	filters: [] as Array<Record<string, string>>,
}));

vi.mock("emdash", async () => {
	const { decodeSlug } = await import("../../../src/utils/slugify.js");
	return {
		decodeSlug,
		getTaxonomyTermsWithCacheHint: async () => ({ data: state.terms, cacheHint: {} }),
		getEmDashCollection: async (
			_collection: string,
			options: { where: Record<string, string> },
		) => {
			state.filters.push(options.where);
			return { entries: [], cacheHint: {} };
		},
		getTermsForEntries: async () => new Map(),
	};
});

const layout = vi.hoisted(() => async () => {
	const { createComponent, render, renderSlot } = await import("astro/runtime/server/index.js");
	return {
		default: createComponent(
			(result, _props, slots) => render`${renderSlot(result, slots.default)}`,
		),
	};
});
vi.mock("../../../../templates/blog/src/layouts/Base.astro", layout);
vi.mock("../../../../templates/blog-cloudflare/src/layouts/Base.astro", layout);
vi.mock("../../../../templates/starter/src/layouts/Base.astro", layout);
vi.mock("../../../../templates/starter-cloudflare/src/layouts/Base.astro", layout);
vi.mock("../../../../demos/simple/src/layouts/Base.astro", layout);
vi.mock("../../../../demos/cloudflare/src/layouts/Base.astro", layout);
vi.mock("../../../../demos/postgres/src/layouts/Base.astro", layout);
vi.mock("../../../../demos/preview/src/layouts/Base.astro", layout);
vi.mock("../../../../demos/playground/src/layouts/Base.astro", layout);

vi.mock("emdash/ui", () => ({ Image: undefined }));

beforeEach(() => {
	state.terms = [];
	state.filters = [];
});

describe.each([
	["templates/blog/category", "category", BlogCategory],
	["templates/blog/tag", "tag", BlogTag],
	["templates/blog-cloudflare/category", "category", CloudflareBlogCategory],
	["templates/blog-cloudflare/tag", "tag", CloudflareBlogTag],
	["templates/starter/category", "category", StarterCategory],
	["templates/starter/tag", "tag", StarterTag],
	["templates/starter-cloudflare/category", "category", CloudflareStarterCategory],
	["templates/starter-cloudflare/tag", "tag", CloudflareStarterTag],
	["demos/simple/category", "category", SimpleCategory],
	["demos/simple/tag", "tag", SimpleTag],
	["demos/cloudflare/category", "category", CloudflareDemoCategory],
	["demos/cloudflare/tag", "tag", CloudflareDemoTag],
	["demos/postgres/category", "category", PostgresCategory],
	["demos/postgres/tag", "tag", PostgresTag],
	["demos/preview/category", "category", PreviewCategory],
	["demos/preview/tag", "tag", PreviewTag],
	["demos/playground/category", "category", PlaygroundCategory],
	["demos/playground/tag", "tag", PlaygroundTag],
] as const)("%s", (_name, taxonomy, component) => {
	async function renderArchive(slug: string): Promise<Response> {
		const container = await AstroContainer.create();
		container.insertPageRoute(
			"/404",
			createPage(() => new Response("Not found", { status: 404 })),
		);
		const page = createPage((result, props, slots) => {
			const createAstro = result.createAstro;
			result.createAstro = (...args) => {
				const astro = createAstro(...args);
				Object.defineProperty(astro, "cache", { value: { set: () => {} } });
				return astro;
			};
			return component(result, props, slots);
		});
		return container.renderToResponse(page, {
			params: { slug },
			request: new Request(`http://localhost/${taxonomy}/${slug}`),
		});
	}

	test.each([
		["news", "news"],
		["日本語", "%E6%97%A5%E6%9C%AC%E8%AA%9E"],
		["%e6%97%a5%e6%9c%ac%e8%aa%9e", "%e6%97%a5%e6%9c%ac%e8%aa%9e"],
		["%e6%97%a5%e6%9c%ac%e8%aa%9e", "%E6%97%A5%E6%9C%AC%E8%AA%9E"],
		["%e6%97%a5%e6%9c%ac%e8%aa%9e", "日本語"],
	])(
		"renders stored slug %s requested as %s and filters by its original value",
		async (stored, requested) => {
			state.terms = [{ slug: stored, label: "Imported term" }];
			const response = await renderArchive(requested);
			expect(response.status).toBe(200);
			const html = await response.text();
			expect(html).toContain("Imported term");
			expect(state.filters).toEqual([{ [taxonomy]: stored }]);
		},
	);

	test.each(["missing", "%zz", "%c0", "trailing%"])(
		"returns 404 for unmatched or malformed slug %s",
		async (requested) => {
			state.terms = [{ slug: "日本語", label: "Existing term" }];
			const response = await renderArchive(requested);
			expect(response.status).toBe(404);
			expect(state.filters).toEqual([]);
		},
	);

	test("prefers an exact slug over an encoded equivalent", async () => {
		state.terms = [
			{ slug: "%e6%97%a5%e6%9c%ac%e8%aa%9e", label: "Encoded term" },
			{ slug: "日本語", label: "Exact term" },
		];
		const response = await renderArchive("%E6%97%A5%E6%9C%AC%E8%AA%9E");
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("Exact term");
		expect(state.filters).toEqual([{ [taxonomy]: "日本語" }]);
	});
});
