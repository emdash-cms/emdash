import { describe, expect, it } from "vitest";

import { resolveHiddenNavItems } from "../../../../src/astro/integration/admin-nav.js";

describe("resolveHiddenNavItems", () => {
	it("keeps known names once, in the order given", () => {
		expect(resolveHiddenNavItems(["comments", "widgets", "comments"])).toEqual([
			"comments",
			"widgets",
		]);
	});

	it("fails the build on an unknown name and lists the valid ones", () => {
		expect(() => resolveHiddenNavItems(["comments", "comment"])).toThrow(
			/Unknown navigation item in .*"comment".*Valid names:.*redirects/,
		);
	});

	it("fails the build when the option is not an array", () => {
		expect(() => resolveHiddenNavItems("comments")).toThrow(/must be an array/);
	});
});
