import { describe, expect, it, vi } from "vitest";

import { linkPortableTextFileUrls } from "../../../src/media/portable-text-file-refs.js";

const ids = new Map([
	["01IMAGE.png", "media-image"],
	["01VIDEO.mp4", "media-video"],
	["uploads/my photo.jpg", "media-gallery"],
]);
const findIds = vi.fn(
	async (keys: string[]) =>
		new Map(
			keys.flatMap((key) => {
				const id = ids.get(key);
				return id ? [[key, id] as const] : [];
			}),
		),
);

describe("linkPortableTextFileUrls", () => {
	it("links image, video, and gallery assets named by a library file URL", async () => {
		const [body] = await linkPortableTextFileUrls(
			[
				[
					{ _type: "image", _key: "a", asset: { url: "/_emdash/api/media/file/01IMAGE.png" } },
					{
						_type: "video",
						_key: "b",
						asset: { _ref: "/_emdash/api/media/file/01VIDEO.mp4", url: "" },
					},
					{
						_type: "gallery",
						_key: "c",
						images: [
							{
								_key: "d",
								asset: { _ref: "", url: "/_emdash/api/media/file/uploads/my%20photo.jpg" },
							},
						],
					},
					{ _type: "image", _key: "e", asset: { url: "/_emdash/api/media/file/01UNKNOWN.png" } },
				],
			],
			findIds,
		);

		expect(body).toEqual([
			{
				_type: "image",
				_key: "a",
				asset: { _ref: "media-image", url: "/_emdash/api/media/file/01IMAGE.png" },
			},
			{
				_type: "video",
				_key: "b",
				asset: { _ref: "media-video", url: "/_emdash/api/media/file/01VIDEO.mp4" },
			},
			{
				_type: "gallery",
				_key: "c",
				images: [
					{
						_key: "d",
						asset: {
							_ref: "media-gallery",
							url: "/_emdash/api/media/file/uploads/my%20photo.jpg",
						},
					},
				],
			},
			{ _type: "image", _key: "e", asset: { url: "/_emdash/api/media/file/01UNKNOWN.png" } },
		]);
	});

	it("leaves assets that already have an id, another provider, or an external URL alone", async () => {
		findIds.mockClear();
		const body = [
			{
				_type: "image",
				asset: { _ref: "media-image", url: "/_emdash/api/media/file/01IMAGE.png" },
			},
			{
				_type: "image",
				asset: { url: "/_emdash/api/media/file/01IMAGE.png", provider: "cloudflare-images" },
			},
			{ _type: "image", asset: { url: "https://example.com/_emdash/api/media/file/01IMAGE.png" } },
		];

		const [linked] = await linkPortableTextFileUrls([body], findIds);

		expect(linked).toEqual(body);
		expect(findIds).not.toHaveBeenCalled();
	});
});
