import { describe, expect, it } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type { PortableTextVideoBlock } from "../../../src/content/converters/types.js";

describe("video block round-trip (core converters)", () => {
	it("preserves every field through PT → PM → PT", () => {
		const block: PortableTextVideoBlock = {
			_type: "video",
			_key: "video1",
			asset: { _ref: "01VIDEO", url: "/_emdash/api/media/file/01VIDEO.mp4" },
			caption: "Launch day",
			width: 1920,
			height: 1080,
		};

		const pm = portableTextToProsemirror([block], { preserveIdentity: true });

		expect(pm.content[0]?.type).toBe("videoBlock");
		expect(prosemirrorToPortableText(pm)).toStrictEqual([block]);
	});

	it("keeps a provider's asset id and provider", () => {
		const block: PortableTextVideoBlock = {
			_type: "video",
			_key: "video1",
			asset: { _ref: "stream-uid", provider: "cloudflare-stream" },
		};

		const pm = portableTextToProsemirror([block], { preserveIdentity: true });

		expect(pm.content[0]).toMatchObject({
			type: "videoBlock",
			attrs: { mediaId: "stream-uid", provider: "cloudflare-stream" },
		});
		expect(prosemirrorToPortableText(pm)).toStrictEqual([block]);
	});

	it("keeps an empty video block empty", () => {
		const block: PortableTextVideoBlock = { _type: "video", _key: "video1" };

		const pm = portableTextToProsemirror([block], { preserveIdentity: true });

		expect(pm.content[0]).toMatchObject({ type: "videoBlock", attrs: { mediaId: null } });
		expect(prosemirrorToPortableText(pm)).toStrictEqual([block]);
	});

	it("writes only the fields that are set", () => {
		const pt = prosemirrorToPortableText({
			type: "doc",
			content: [
				{
					type: "videoBlock",
					attrs: {
						src: "/_emdash/api/media/file/01VIDEO.mp4",
						mediaId: "01VIDEO",
						provider: "local",
						caption: "",
						width: null,
						height: 0,
					},
				},
			],
		});

		expect(pt).toStrictEqual([
			{
				_type: "video",
				_key: expect.any(String),
				asset: { _ref: "01VIDEO", url: "/_emdash/api/media/file/01VIDEO.mp4" },
			},
		]);
	});

	it.each([
		["other fields", { autoplay: true }],
		["a caption that isn't text", { caption: 5 }],
		["a size that isn't a whole number", { width: 640.5, height: 360 }],
		["other asset fields", { asset: { _ref: "01VIDEO", _type: "reference" } }],
		["an asset without a reference", { asset: { url: "https://example.com/clip.mp4" } }],
	])("leaves a video block with %s to its plugin", (_, fields) => {
		const block = {
			_type: "video",
			_key: "plugin1",
			asset: { _ref: "01VIDEO" },
			...fields,
		};

		const pm = portableTextToProsemirror([block], { preserveIdentity: true });

		expect(pm.content[0]?.type).not.toBe("videoBlock");
		expect(prosemirrorToPortableText(pm)).toStrictEqual([block]);
	});
});
