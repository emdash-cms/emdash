/**
 * Regression for #1332: RecentPosts hardcoded `/posts/${id}` with no way to
 * override for sites using a catch-all route. buildRecentPostUrl is the
 * extracted, testable piece of that fix (mirrors buildLiveSearchResultUrl,
 * which fixed the sibling LiveSearch half of #1332 in PR #1387).
 */
import { describe, expect, it } from "vitest";

import { buildRecentPostUrl } from "../../../src/components/widgets/recent-posts-url.js";

describe("buildRecentPostUrl", () => {
	it("substitutes :slug into the default template", () => {
		expect(buildRecentPostUrl("hello-world", "/posts/:slug")).toBe("/posts/hello-world");
	});

	it("supports a catch-all route template with no /posts/ prefix", () => {
		expect(buildRecentPostUrl("hello-world", "/:slug")).toBe("/hello-world");
	});

	it("treats dollar signs in the slug as literal text", () => {
		expect(buildRecentPostUrl("slug$$", "/posts/:slug")).toBe("/posts/slug$$");
	});
});
