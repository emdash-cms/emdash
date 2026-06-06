/**
 * Tests for WXR import multilingual handling and custom-taxonomy
 * pass-through. Covers `wxrPostToNormalizedItem` only -- end-to-end
 * persistence is exercised by the integration tests.
 *
 * @see https://github.com/emdash-cms/emdash/issues/1080 (WPML / Polylang)
 * @see https://github.com/emdash-cms/emdash/issues/1061 (taxonomies dropped)
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

describe("wxrPostToNormalizedItem locale + translationGroup", () => {
	it("forwards parser-promoted WPML locale onto NormalizedItem", () => {
		const post = makePost({
			id: 1,
			title: "Hello",
			postName: "hello",
			postType: "post",
			locale: "en",
			translationGroup: "wpml:42",
		});

		const item = wxrPostToNormalizedItem(post, new Map());

		expect(item.locale).toBe("en");
		expect(item.translationGroup).toBe("wpml:42");
	});

	it("leaves locale/translationGroup undefined when the parser produced none", () => {
		const post = makePost({ id: 1, title: "Mono", postName: "mono", postType: "post" });

		const item = wxrPostToNormalizedItem(post, new Map());

		expect(item.locale).toBeUndefined();
		expect(item.translationGroup).toBeUndefined();
	});
});

describe("wxrPostToNormalizedItem custom taxonomy filtering", () => {
	it("strips Polylang's `language` taxonomy from customTaxonomies", () => {
		// The parser promotes the language taxonomy to `post.locale` (the
		// caller-facing field). Re-emitting it as a content taxonomy would
		// require EmDash to also have a `language` taxonomy registered,
		// which it doesn't -- and would duplicate the locale signal.
		const post = makePost({
			id: 1,
			title: "Bonjour",
			postType: "post",
			customTaxonomies: new Map<string, string[]>([
				["language", ["fr"]],
				["genre", ["fiction"]],
			]),
			locale: "fr",
		});

		const item = wxrPostToNormalizedItem(post, new Map());

		expect(item.customTaxonomies).toBeDefined();
		expect(item.customTaxonomies?.language).toBeUndefined();
		expect(item.customTaxonomies?.genre).toEqual(["fiction"]);
	});

	it("returns undefined customTaxonomies when only `language` was present", () => {
		const post = makePost({
			id: 1,
			title: "Solo language",
			postType: "post",
			customTaxonomies: new Map<string, string[]>([["language", ["en"]]]),
			locale: "en",
		});

		const item = wxrPostToNormalizedItem(post, new Map());

		expect(item.customTaxonomies).toBeUndefined();
	});

	it("preserves multi-value custom taxonomy entries", () => {
		const post = makePost({
			id: 1,
			title: "Multi",
			postType: "post",
			customTaxonomies: new Map<string, string[]>([["genre", ["sci-fi", "noir"]]]),
		});

		const item = wxrPostToNormalizedItem(post, new Map());

		expect(item.customTaxonomies?.genre).toEqual(["sci-fi", "noir"]);
	});
});
