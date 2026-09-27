import { describe, expect, it, vi } from "vitest";

import { injectCoreRoutes } from "../../../src/astro/integration/routes.js";

describe("block type route registration", () => {
	it("registers list, item, and explicit activation routes", () => {
		const injectRoute = vi.fn();
		injectCoreRoutes(injectRoute);
		const patterns = injectRoute.mock.calls.map((call) => (call[0] as { pattern: string }).pattern);

		expect(patterns).toContain("/_emdash/api/schema/block-types");
		expect(patterns).toContain("/_emdash/api/schema/block-types/[slug]");
		expect(patterns).toContain(
			"/_emdash/api/schema/block-types/[slug]/versions/[version]/activate",
		);
		expect(
			patterns.indexOf("/_emdash/api/schema/block-types/[slug]/versions/[version]/activate"),
		).toBeLessThan(patterns.indexOf("/_emdash/api/schema/block-types/[slug]"));
	});

	it("does not expose block type deletion", async () => {
		const route = await import("../../../src/astro/routes/api/schema/block-types/[slug]/index.js");
		expect("DELETE" in route).toBe(false);
	});
});
