import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/taxonomies/index.js", () => ({
	getTaxonomyTerms: async (taxonomy: string) => [
		{
			slug: taxonomy === "category" ? "notes" : "agents",
			label: taxonomy === "category" ? "Notes" : "Agents",
			count: 2,
		},
	],
}));

vi.mock("../../src/query.js", () => ({
	getPublishedDates: async () => ({ dates: ["2026-03-15T12:00:00.000Z"] }),
	getEmDashCollection: async () => ({
		entries: [{ id: "hello-world", data: { title: "Hello World" } }],
	}),
}));

import Archives from "../../src/components/widgets/Archives.astro";
import Categories from "../../src/components/widgets/Categories.astro";
import RecentPosts from "../../src/components/widgets/RecentPosts.astro";
import Search from "../../src/components/widgets/Search.astro";
import Tags from "../../src/components/widgets/Tags.astro";

afterEach(() => vi.unstubAllEnvs());

describe("widget public URLs", () => {
	it.each(["/", "/field-notes", "/field-notes/"])(
		"keeps links and search submissions under base %s",
		async (base) => {
			vi.stubEnv("BASE_URL", base);
			const container = await AstroContainer.create();
			const prefix = base === "/" ? "" : "/field-notes";
			const categories = await container.renderToString(Categories);
			const tags = await container.renderToString(Tags);
			const search = await container.renderToString(Search);
			const archives = await container.renderToString(Archives);
			const recent = await container.renderToString(RecentPosts, {
				props: { showDate: false },
				locals: {},
			});
			expect(categories).toContain(`href="${prefix}/category/notes"`);
			expect(tags).toContain(`href="${prefix}/tag/agents"`);
			expect(search).toContain(`action="${prefix}/search"`);
			expect(archives).toContain(`href="${prefix}/archives/2026/03"`);
			expect(recent).toContain(`href="${prefix}/posts/hello-world"`);
		},
	);
});
