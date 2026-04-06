/**
 * Tests for WXR import date handling
 *
 * Verifies that wxrPostToNormalizedItem correctly preserves post dates
 * and publish status from WordPress exports.
 *
 * @see https://github.com/emdash-cms/emdash/issues/322
 */

import { describe, it, expect } from "vitest";

import type { WxrPost } from "../../../src/cli/wxr/parser.js";
import { wxrPostToNormalizedItem } from "../../../src/import/sources/wxr.js";

function makePost(overrides: Partial<WxrPost> = {}): WxrPost {
	return {
		categories: [],
		tags: [],
		meta: new Map(),
		...overrides,
	};
}

describe("wxrPostToNormalizedItem date handling", () => {
	it("prefers postDateGmt over postDate for the date field", () => {
		const post = makePost({
			id: 1,
			title: "Test Post",
			postType: "post",
			status: "publish",
			postName: "test-post",
			// postDate is site-local time (no timezone), postDateGmt is UTC
			postDate: "2023-06-15 08:30:00",
			postDateGmt: "2023-06-15 12:30:00",
			pubDate: "Thu, 15 Jun 2023 12:30:00 +0000",
		});

		const item = wxrPostToNormalizedItem(post, new Map());

		// Should use the GMT date, not the site-local date
		expect(item.date.toISOString()).toBe("2023-06-15T12:30:00.000Z");
	});

	it("falls back to pubDate when postDateGmt is missing", () => {
		const post = makePost({
			id: 2,
			title: "Post without GMT date",
			postType: "post",
			status: "publish",
			postName: "no-gmt",
			postDate: "2023-06-15 08:30:00",
			pubDate: "Thu, 15 Jun 2023 12:30:00 +0000",
		});

		const item = wxrPostToNormalizedItem(post, new Map());

		// pubDate is RFC 2822 with timezone, should parse correctly to UTC
		expect(item.date.toISOString()).toBe("2023-06-15T12:30:00.000Z");
	});

	it("falls back to postDate when both postDateGmt and pubDate are missing", () => {
		const post = makePost({
			id: 3,
			title: "Post with only local date",
			postType: "post",
			status: "draft",
			postName: "local-only",
			postDate: "2023-06-15 08:30:00",
		});

		const item = wxrPostToNormalizedItem(post, new Map());

		// postDate is site-local, parsed as-is (imprecise but best available)
		expect(item.date).toBeInstanceOf(Date);
		expect(item.date.getTime()).not.toBeNaN();
	});

	it("defaults to current time when no dates are available", () => {
		const before = Date.now();
		const post = makePost({
			id: 4,
			title: "Post with no dates",
			postType: "post",
			status: "draft",
			postName: "no-dates",
		});

		const item = wxrPostToNormalizedItem(post, new Map());
		const after = Date.now();

		expect(item.date.getTime()).toBeGreaterThanOrEqual(before);
		expect(item.date.getTime()).toBeLessThanOrEqual(after);
	});

	it("ignores the WXR sentinel value '0000-00-00 00:00:00' for postDateGmt", () => {
		const post = makePost({
			id: 5,
			title: "Draft with zero GMT date",
			postType: "post",
			status: "draft",
			postName: "zero-gmt",
			postDate: "2023-06-15 08:30:00",
			postDateGmt: "0000-00-00 00:00:00",
			pubDate: "Thu, 15 Jun 2023 12:30:00 +0000",
		});

		const item = wxrPostToNormalizedItem(post, new Map());

		// Should NOT use the zero sentinel, should fall back to pubDate
		expect(item.date.toISOString()).toBe("2023-06-15T12:30:00.000Z");
	});

	it("uses postModifiedGmt over postModified for the modified field", () => {
		const post = makePost({
			id: 6,
			title: "Modified Post",
			postType: "post",
			status: "publish",
			postName: "modified",
			postDate: "2023-06-15 08:30:00",
			postDateGmt: "2023-06-15 12:30:00",
			postModified: "2023-07-01 10:00:00",
			postModifiedGmt: "2023-07-01 14:00:00",
		});

		const item = wxrPostToNormalizedItem(post, new Map());

		expect(item.modified).toBeInstanceOf(Date);
		expect(item.modified!.toISOString()).toBe("2023-07-01T14:00:00.000Z");
	});

	it("returns undefined for modified when no modified dates exist", () => {
		const post = makePost({
			id: 7,
			title: "Never Modified",
			postType: "post",
			status: "publish",
			postName: "never-modified",
			postDate: "2023-06-15 08:30:00",
			postDateGmt: "2023-06-15 12:30:00",
		});

		const item = wxrPostToNormalizedItem(post, new Map());

		expect(item.modified).toBeUndefined();
	});

	it("skips sentinel '0000-00-00 00:00:00' for postModifiedGmt and falls back", () => {
		const post = makePost({
			id: 8,
			title: "Draft with zero modified GMT",
			postType: "post",
			status: "draft",
			postName: "zero-modified-gmt",
			postDate: "2023-06-15 08:30:00",
			postDateGmt: "2023-06-15 12:30:00",
			postModified: "2023-07-01 10:00:00",
			postModifiedGmt: "0000-00-00 00:00:00",
		});

		const item = wxrPostToNormalizedItem(post, new Map());

		// Should skip the sentinel and fall back to postModified
		expect(item.modified).toBeInstanceOf(Date);
		expect(item.modified!.getTime()).not.toBeNaN();
	});
});
