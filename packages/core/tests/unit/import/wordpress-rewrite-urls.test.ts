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

	it("rewrites the URL of a self-hosted video embed", () => {
		const oldVideoUrl = "https://example.com/wp-content/uploads/2026/01/clip.mp4";
		const newVideoUrl = "/_emdash/media/file/imported/clip.mp4";
		const videoMap = { [oldVideoUrl]: newVideoUrl };
		const baseMap = buildBaseUrlMap(videoMap);
		const blocks = [
			{
				_type: "embed",
				provider: "video",
				url: oldVideoUrl,
			},
		];

		const result = rewritePortableTextUrls(blocks, videoMap, baseMap);

		expect(result).toEqual({ changed: true, urlsRewritten: 1 });
		expect(blocks[0]?.url).toBe(newVideoUrl);
	});

	it("rewrites the URL of a self-hosted audio embed", () => {
		const oldAudioUrl = "https://example.com/wp-content/uploads/2026/01/episode.mp3";
		const newAudioUrl = "/_emdash/media/file/imported/episode.mp3";
		const audioMap = { [oldAudioUrl]: newAudioUrl };
		const baseMap = buildBaseUrlMap(audioMap);
		const blocks = [
			{
				_type: "embed",
				provider: "audio",
				url: oldAudioUrl,
			},
		];

		const result = rewritePortableTextUrls(blocks, audioMap, baseMap);

		expect(result).toEqual({ changed: true, urlsRewritten: 1 });
		expect(blocks[0]?.url).toBe(newAudioUrl);
	});

	it("rewrites the old URL inside a video embed's html", () => {
		const oldVideoUrl = "https://example.com/wp-content/uploads/2026/01/clip.mp4";
		const newVideoUrl = "/_emdash/media/file/imported/clip.mp4";
		const videoMap = { [oldVideoUrl]: newVideoUrl };
		const baseMap = buildBaseUrlMap(videoMap);
		const blocks = [
			{
				_type: "embed",
				provider: "video",
				url: oldVideoUrl,
				html: `<video controls src="${oldVideoUrl}"></video>`,
			},
		];

		const result = rewritePortableTextUrls(blocks, videoMap, baseMap);

		expect(result.changed).toBe(true);
		expect(blocks[0]?.html).toBe(`<video controls src="${newVideoUrl}"></video>`);
		expect(blocks[0]?.html).not.toContain("example.com");
	});

	it("leaves an embed of a provider that is not in the map alone", () => {
		const videoMap = { "https://example.com/wp-content/uploads/2026/01/clip.mp4": "/new/clip.mp4" };
		const baseMap = buildBaseUrlMap(videoMap);
		const youtubeUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
		const blocks = [
			{
				_type: "embed",
				provider: "youtube",
				url: youtubeUrl,
			},
		];

		const result = rewritePortableTextUrls(blocks, videoMap, baseMap);

		expect(result).toEqual({ changed: false, urlsRewritten: 0 });
		expect(blocks[0]?.url).toBe(youtubeUrl);
	});

	it("rewrites a video embed that a media-text block nests in a column", () => {
		const oldVideoUrl = "https://example.com/wp-content/uploads/2026/01/clip.mp4";
		const newVideoUrl = "/_emdash/media/file/imported/clip.mp4";
		const videoMap = { [oldVideoUrl]: newVideoUrl };
		const baseMap = buildBaseUrlMap(videoMap);
		const blocks = [
			{
				_type: "columns",
				columns: [{ content: [{ _type: "embed", provider: "video", url: oldVideoUrl }] }],
			},
		];

		const result = rewritePortableTextUrls(blocks, videoMap, baseMap);

		expect(result).toEqual({ changed: true, urlsRewritten: 1 });
		expect(blocks[0]?.columns?.[0]?.content?.[0]?.url).toBe(newVideoUrl);
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
