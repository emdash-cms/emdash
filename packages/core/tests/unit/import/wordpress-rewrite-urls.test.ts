import { gutenbergToPortableText } from "@emdash-cms/gutenberg-to-portable-text";
import { describe, expect, it } from "vitest";

import {
	buildBaseUrlMap,
	findMatchingUrl,
	getBaseUrl,
	rewritePortableTextUrls,
	rewriteStringUrls,
} from "../../../src/astro/routes/api/import/wordpress/rewrite-url-helpers.js";
import type { PortableTextBlock } from "../../../src/astro/routes/api/import/wordpress/rewrite-url-helpers.js";

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

	it("matches unquoted image URLs followed by a closing tag delimiter", () => {
		const baseMap = buildBaseUrlMap(urlMap);
		const result = rewriteStringUrls(`<img src=${oldVariantUrl}>`, urlMap, baseMap);

		expect(result).toEqual({
			newValue: `<img src=${newUrl}>`,
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

	it("rewrites a legacy string image link", () => {
		const baseMap = buildBaseUrlMap(urlMap);
		const blocks = [
			{
				_type: "image",
				asset: { _type: "reference", _ref: "/already/local.jpg", url: "/already/local.jpg" },
				link: oldVariantUrl,
			},
		];

		const result = rewritePortableTextUrls(blocks, urlMap, baseMap);

		expect(result).toEqual({ changed: true, urlsRewritten: 1 });
		expect(blocks[0]?.link).toBe(newUrl);
	});

	it("rewrites an object image link in place and keeps its blank flag", () => {
		const baseMap = buildBaseUrlMap(urlMap);
		const blocks = [
			{
				_type: "image",
				asset: { _type: "reference", _ref: "/already/local.jpg", url: "/already/local.jpg" },
				link: { href: oldVariantUrl, blank: true },
			},
		];

		const result = rewritePortableTextUrls(blocks, urlMap, baseMap);

		expect(result).toEqual({ changed: true, urlsRewritten: 1 });
		expect(blocks[0]?.link).toEqual({ href: newUrl, blank: true });
	});
});

describe("WordPress import URL rewriting reaches links, not only images", () => {
	const brochure = "https://example.com/wp-content/uploads/2016/02/brochure.pdf";
	const imported = "/_emdash/api/media/file/01KBROCHURE.pdf";
	const hero = "https://example.com/wp-content/uploads/2016/02/hero-1024x695.jpg";
	const heroImported = "/_emdash/api/media/file/01KHERO.jpg";
	const urlMap = {
		[brochure]: imported,
		"https://example.com/wp-content/uploads/2016/02/hero.jpg": heroImported,
	};
	const baseMap = buildBaseUrlMap(urlMap);
	const convert = (html: string): PortableTextBlock[] =>
		gutenbergToPortableText(html) as PortableTextBlock[];

	it("rewrites a hyperlink to an imported attachment, as the importer's converter stores it", () => {
		const blocks = convert(
			`<!-- wp:paragraph -->\n<p>Read the <a href="${brochure}">brochure</a>.</p>\n<!-- /wp:paragraph -->`,
		);
		expect(blocks[0]?.markDefs).toEqual([
			expect.objectContaining({ _type: "link", href: brochure }),
		]);

		expect(rewritePortableTextUrls(blocks, urlMap, baseMap)).toEqual({
			changed: true,
			urlsRewritten: 1,
		});
		expect(blocks[0]?.markDefs).toEqual([
			expect.objectContaining({ _type: "link", href: imported }),
		]);
	});

	it("rewrites a hyperlink in a classic-editor post, and a size of an image", () => {
		const blocks = convert(
			`<p><a href="${brochure}">PDF</a> and <a href="${hero}">the picture</a></p>`,
		);

		expect(rewritePortableTextUrls(blocks, urlMap, baseMap)).toEqual({
			changed: true,
			urlsRewritten: 2,
		});
		expect(blocks[0]?.markDefs).toEqual([
			expect.objectContaining({ href: imported }),
			expect.objectContaining({ href: heroImported }),
		]);
	});

	it("leaves a link the import did not bring across", () => {
		const other = "https://example.com/about/";
		const blocks = convert(`<p><a href="${other}">About</a></p>`);

		expect(rewritePortableTextUrls(blocks, urlMap, baseMap)).toEqual({
			changed: false,
			urlsRewritten: 0,
		});
		expect(blocks[0]?.markDefs).toEqual([expect.objectContaining({ href: other })]);
	});

	it("rewrites a table cell's link, a file block, buttons and a cover's background and content", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "table",
				_key: "t",
				rows: [
					{
						_type: "tableRow",
						_key: "r",
						cells: [
							{
								_type: "tableCell",
								_key: "c",
								content: [],
								markDefs: [{ _type: "link", _key: "l", href: brochure }],
							},
						],
					},
				],
			},
			{ _type: "file", _key: "f", url: brochure, filename: "brochure.pdf" },
			{ _type: "button", _key: "b", text: "Download", url: brochure },
			{
				_type: "buttons",
				_key: "bs",
				buttons: [{ _type: "button", _key: "b1", text: "Get it", url: brochure }],
			},
			{
				_type: "cover",
				_key: "cv",
				backgroundImage: hero,
				content: [
					{
						_type: "block",
						_key: "p",
						children: [],
						markDefs: [{ _type: "link", _key: "l2", href: brochure }],
					},
				],
			},
		];

		expect(rewritePortableTextUrls(blocks, urlMap, baseMap)).toEqual({
			changed: true,
			urlsRewritten: 6,
		});
		expect(JSON.stringify(blocks)).not.toContain("example.com");
	});
});
