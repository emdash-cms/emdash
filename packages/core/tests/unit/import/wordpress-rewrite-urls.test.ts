import type { PortableTextBlock } from "@emdash-cms/gutenberg-to-portable-text";
import { describe, expect, it } from "vitest";

import {
	buildBaseUrlMap,
	findMatchingUrl,
	getBaseUrl,
	rewritePortableTextUrls,
	rewriteStringUrls,
} from "../../../src/astro/routes/api/import/wordpress/rewrite-url-helpers.js";
import { relativizeContentLinks } from "../../../src/import/utils.js";

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

	it("rewrites media URLs outside image blocks", () => {
		const pdf = "https://example.com/wp-content/uploads/2026/01/report.pdf";
		const mp3 = "https://example.com/wp-content/uploads/2026/01/song.mp3";
		const map = {
			...urlMap,
			[pdf]: "/_emdash/media/file/imported/report.pdf",
			[mp3]: "/_emdash/media/file/imported/song.mp3",
		};
		const link = (href: string) => ({ _type: "link", _key: "l", href });
		const blocks = [
			{ _type: "block", markDefs: [link(pdf), link("https://example.com/about/")] },
			{
				_type: "table",
				rows: [{ cells: [{ markDefs: [link(pdf)] }] }],
			},
			{
				_type: "cover",
				backgroundImage: oldVariantUrl,
				content: [{ _type: "block", markDefs: [link(pdf)] }],
			},
			{ _type: "file", url: pdf },
			{ _type: "embed", url: mp3, html: `<audio controls src="${mp3}"></audio>` },
			{ _type: "htmlBlock", html: `<a href="${pdf}">Report</a>` },
			{ _type: "button", url: pdf },
			{ _type: "buttons", buttons: [{ _type: "button", url: pdf }] },
		];

		const result = rewritePortableTextUrls(blocks, map, buildBaseUrlMap(map));

		expect(result).toEqual({ changed: true, urlsRewritten: 9 });
		expect(JSON.stringify(blocks)).not.toContain("wp-content");
		expect(blocks[0]).toMatchObject({
			markDefs: [{ href: map[pdf] }, { href: "https://example.com/about/" }],
		});
		expect(blocks[2]).toMatchObject({ backgroundImage: newUrl });
		expect(blocks[4]).toMatchObject({
			url: map[mp3],
			html: `<audio controls src="${map[mp3]}"></audio>`,
		});
	});
	it("rewrites upload links that survived link relativization", () => {
		const pdf = "https://example.com/wp-content/uploads/2026/01/report.pdf";
		const map = { [pdf]: "/_emdash/media/file/imported/report.pdf" };
		const blocks: PortableTextBlock[] = [
			{ _type: "htmlBlock", _key: "h", html: `<a href="${pdf}">Report</a>` },
			{
				_type: "columns",
				_key: "c",
				columns: [
					{
						_type: "column",
						_key: "co",
						content: [
							{
								_type: "buttons",
								_key: "b",
								buttons: [{ _type: "button", _key: "bt", text: "PDF", url: pdf }],
							},
						],
					},
				],
			},
		];

		relativizeContentLinks(blocks, "https://example.com");
		rewritePortableTextUrls(blocks, map, buildBaseUrlMap(map));

		expect(JSON.stringify(blocks)).not.toContain("wp-content");
	});
});
