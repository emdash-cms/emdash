import { gutenbergToPortableText } from "@emdash-cms/gutenberg-to-portable-text";
import { describe, expect, it } from "vitest";

import {
	buildBaseUrlMap,
	findMatchingUrl,
	rewritePortableTextUrls,
	rewriteStringUrls,
} from "../../../src/astro/routes/api/import/wordpress/rewrite-url-helpers.js";
import type { PortableTextBlock } from "../../../src/astro/routes/api/import/wordpress/rewrite-url-helpers.js";

describe("a URL map key that carries a query stands for that URL alone", () => {
	// An attachment's shortlink: WordPress answers it for every upload, and an
	// image linked to its attachment page can keep it. Its base is the home page.
	const shortlink = "https://example.com/?attachment_id=7";
	const file = "/_emdash/api/media/file/01KPHOTO.jpg";
	const upload = "https://example.com/wp-content/uploads/2026/01/photo.jpg";
	const uploadImported = "/_emdash/api/media/file/01KUPLOAD.jpg";
	const urlMap = { [shortlink]: file, [upload]: uploadImported };
	const baseMap = buildBaseUrlMap(urlMap);

	it("matches exactly, and never the home page, another shortlink or another attachment", () => {
		expect(findMatchingUrl(shortlink, urlMap, baseMap)).toBe(file);
		for (const other of [
			"https://example.com/",
			"https://example.com/?p=10",
			"https://example.com/?attachment_id=71",
		]) {
			expect(findMatchingUrl(other, urlMap, baseMap), other).toBeNull();
		}
		// A key without a query still matches its variants by its base.
		expect(findMatchingUrl(`${upload}?w=300`, urlMap, baseMap)).toBe(uploadImported);
	});

	it("rewrites an image's link to it in converted content, and no other image's link", () => {
		// A classic-editor image linked to its attachment page, and the same image
		// linked to the home page and to a post. Each image's own file moves too.
		const linked = (href: string) => `<a href="${href}"><img src="${upload}" alt="" /></a>`;
		const blocks = gutenbergToPortableText(
			`<p>${linked(shortlink)}${linked("https://example.com/")}${linked("https://example.com/?p=10")}</p>`,
		) as PortableTextBlock[];

		expect(rewritePortableTextUrls(blocks, urlMap, baseMap)).toEqual({
			changed: true,
			urlsRewritten: 4,
		});
		expect(blocks.map(({ asset, link }) => ({ url: asset?.url, link }))).toEqual([
			{ url: uploadImported, link: file },
			{ url: uploadImported, link: "https://example.com/" },
			{ url: uploadImported, link: "https://example.com/?p=10" },
		]);
	});

	it("in a string, only where the URL ends with it", () => {
		const value =
			`<a href="${shortlink}">a</a> <a href="https://example.com/?attachment_id=71">b</a> ` +
			`<a href="https://example.com/">home</a> ${shortlink}.`;

		expect(rewriteStringUrls(value, urlMap, baseMap)).toEqual({
			newValue:
				`<a href="${file}">a</a> <a href="https://example.com/?attachment_id=71">b</a> ` +
				`<a href="https://example.com/">home</a> ${file}.`,
			changed: true,
			urlsRewritten: 1,
		});
	});
});
