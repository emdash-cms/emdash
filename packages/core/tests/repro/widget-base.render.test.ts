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

import Categories from "../../src/components/widgets/Categories.astro";
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
			expect(categories).toContain(`href="${prefix}/category/notes"`);
			expect(tags).toContain(`href="${prefix}/tag/agents"`);
			expect(search).toContain(`action="${prefix}/search"`);
		},
	);
});
