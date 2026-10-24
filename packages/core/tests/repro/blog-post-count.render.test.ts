import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { createComponent as createPage } from "astro/runtime/server/index.js";
import { describe, expect, test, vi } from "vitest";

import DemoCloudflarePosts from "../../../../demos/cloudflare/src/pages/posts/index.astro";
import PlaygroundPosts from "../../../../demos/playground/src/pages/posts/index.astro";
import PostgresPosts from "../../../../demos/postgres/src/pages/posts/index.astro";
import PreviewPosts from "../../../../demos/preview/src/pages/posts/index.astro";
import SimplePosts from "../../../../demos/simple/src/pages/posts/index.astro";
import CloudflarePosts from "../../../../templates/blog-cloudflare/src/pages/posts/index.astro";
import NodePosts from "../../../../templates/blog/src/pages/posts/index.astro";

function expectArchiveHeader(html: string): void {
	const header = html.match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0];
	expect(header).toMatch(/<h1\b[^>]*>\s*All Posts\s*<\/h1>/);
	expect(header).not.toMatch(/\b\d+\s+articles?\b/);
}

const page = vi.hoisted(() => ({ count: 20, nextCursor: "second-page" as string | undefined }));

vi.mock("emdash", () => ({
	getEmDashCollection: async () => ({
		entries: Array.from({ length: page.count }, (_, index) => ({
			id: `post-${index}`,
			data: { id: `post-${index}`, title: `Post ${index}`, content: [] },
			edit: {},
		})),
		cacheHint: {},
		nextCursor: page.nextCursor,
	}),
	getTermsForEntries: async () => new Map(),
}));

vi.mock("../../../../templates/blog/src/layouts/Base.astro", async () => {
	const { createComponent, render, renderSlot } = await import("astro/runtime/server/index.js");
	return {
		default: createComponent(
			(result, _props, slots) => render`${renderSlot(result, slots.default)}`,
		),
	};
});

vi.mock("../../../../templates/blog-cloudflare/src/layouts/Base.astro", async () => {
	const { createComponent, render, renderSlot } = await import("astro/runtime/server/index.js");
	return {
		default: createComponent(
			(result, _props, slots) => render`${renderSlot(result, slots.default)}`,
		),
	};
});

describe.each([
	["Node", NodePosts],
	["Cloudflare", CloudflarePosts],
] as const)("%s blog archive", (_name, component) => {
	test("keeps the archive heading consistent across pages while retaining posts and navigation", async () => {
		const container = await AstroContainer.create();
		page.count = 20;
		page.nextCursor = "second-page";
		const first = await container.renderToString(component, {
			request: new Request("http://localhost/posts"),
		});
		page.count = 8;
		page.nextCursor = undefined;
		const last = await container.renderToString(component, {
			request: new Request("http://localhost/posts?cursor=second-page"),
		});
		expectArchiveHeader(first);
		expectArchiveHeader(last);
		expect(first.match(/<article\b/g)).toHaveLength(20);
		expect(last.match(/<article\b/g)).toHaveLength(8);
		expect(first).toContain('href="/posts?cursor=second-page"');
		expect(last).toContain('href="/posts"');
		expect(last).not.toContain("Next page");
	});
});

const demoLayout = vi.hoisted(() => async () => {
	const { createComponent, render, renderSlot } = await import("astro/runtime/server/index.js");
	return {
		default: createComponent(
			(result, _props, slots) => render`${renderSlot(result, slots.default)}`,
		),
	};
});
vi.mock("../../../../demos/simple/src/layouts/Base.astro", demoLayout);
vi.mock("../../../../demos/cloudflare/src/layouts/Base.astro", demoLayout);
vi.mock("../../../../demos/postgres/src/layouts/Base.astro", demoLayout);
vi.mock("../../../../demos/preview/src/layouts/Base.astro", demoLayout);
vi.mock("../../../../demos/playground/src/layouts/Base.astro", demoLayout);

describe.each([
	["simple", SimplePosts],
	["cloudflare", DemoCloudflarePosts],
	["postgres", PostgresPosts],
	["preview", PreviewPosts],
	["playground", PlaygroundPosts],
] as const)("%s blog demo", (_name, component) => {
	test("shows the shared archive heading and retains all posts", async () => {
		page.count = 28;
		page.nextCursor = undefined;
		const container = await AstroContainer.create();
		const withCache = createPage((result, props, slots) => {
			const createAstro = result.createAstro;
			result.createAstro = (...args) => {
				const astro = createAstro(...args);
				Object.defineProperty(astro, "cache", { value: { set: () => {} } });
				return astro;
			};
			return component(result, props, slots);
		});
		const html = await container.renderToString(withCache, {
			request: new Request("http://localhost/posts"),
		});
		expectArchiveHeader(html);
		expect(html.match(/<article\b/g)).toHaveLength(28);
	});
});
