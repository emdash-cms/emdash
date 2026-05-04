import { describe, expect, it } from "vitest";

import {
	buildBaseUrlMap,
	findMatchingUrl,
	getBaseUrl,
	rewritePortableTextUrls,
	rewriteStringUrls,
} from "../../../src/astro/routes/api/import/wordpress/rewrite-url-helpers.js";

describe("WordPress import URL rewriting", () => {
	const oldOriginalUrl = "https://example.com/wp-content/uploads/2026/01/hero.jpg";
	const oldVariantUrl = "https://example.com/wp-content/uploads/2026/01/hero-1024x695.jpg";
	const newUrl = "/_emdash/media/file/imported/hero.jpg";
	const urlMap = { [oldOriginalUrl]: newUrl };

	it("strips query strings for base matching without changing filenames", () => {
		expect(getBaseUrl(`${oldVariantUrl}?w=1024`)).toBe(oldVariantUrl);
	});

	it("matches Portable Text image asset URLs that use a WordPress size suffix", () => {
		const baseMap = buildBaseUrlMap(urlMap);
		const blocks = [
			{
				_type: "image",
				asset: {
					_type: "reference",
					_ref: oldVariantUrl,
					url: oldVariantUrl,
				},
			},
		];

		const result = rewritePortableTextUrls(blocks, urlMap, baseMap);

		expect(result).toEqual({ changed: true, urlsRewritten: 1 });
		expect(blocks[0]?.asset?.url).toBe(newUrl);
		expect(blocks[0]?.asset?._ref).toBe(newUrl);
	});

	it("matches string URLs that use a WordPress size suffix", () => {
		const baseMap = buildBaseUrlMap(urlMap);
		const result = rewriteStringUrls(
			`<img src="${oldVariantUrl}?resize=1024,695" alt="Hero">`,
			urlMap,
			baseMap,
		);

		expect(result).toEqual({
			newValue: `<img src="${newUrl}" alt="Hero">`,
			changed: true,
			urlsRewritten: 1,
		});
	});

	it("keeps exact matching for original attachment URLs", () => {
		const baseMap = buildBaseUrlMap(urlMap);

		expect(findMatchingUrl(oldOriginalUrl, urlMap, baseMap)).toBe(newUrl);
	});

	it("preserves dimension-named original attachment URLs while matching their variants", () => {
		const dimensionNamedOriginal =
			"https://example.com/wp-content/uploads/2026/01/banner-300x250.jpg";
		const dimensionNamedVariant =
			"https://example.com/wp-content/uploads/2026/01/banner-300x250-150x125.jpg";
		const importedUrl = "/_emdash/media/file/imported/banner-300x250.jpg";
		const exactMap = { [dimensionNamedOriginal]: importedUrl };
		const baseMap = buildBaseUrlMap(exactMap);

		expect(findMatchingUrl(dimensionNamedVariant, exactMap, baseMap)).toBe(importedUrl);
	});

	it("does not rewrite URL prefixes inside longer filenames", () => {
		const baseMap = buildBaseUrlMap(urlMap);
		const value = `<img src="${oldVariantUrl}.webp" alt="Hero">`;

		expect(rewriteStringUrls(value, urlMap, baseMap)).toEqual({
			newValue: value,
			changed: false,
			urlsRewritten: 0,
		});
	});

	it("rewrites bare variant URLs followed by prose punctuation", () => {
		const baseMap = buildBaseUrlMap(urlMap);

		expect(rewriteStringUrls(`Image: ${oldVariantUrl}, next`, urlMap, baseMap)).toEqual({
			newValue: `Image: ${newUrl}, next`,
			changed: true,
			urlsRewritten: 1,
		});

		expect(rewriteStringUrls(`Image: ${oldVariantUrl}.`, urlMap, baseMap)).toEqual({
			newValue: `Image: ${newUrl}.`,
			changed: true,
			urlsRewritten: 1,
		});
	});
});
