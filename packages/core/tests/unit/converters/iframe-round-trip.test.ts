import { describe, expect, it } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type { PortableTextIframeBlock } from "../../../src/content/converters/types.js";

describe("iframe block round-trip (core converters)", () => {
	it("preserves every field through PT → PM → PT", () => {
		const block: PortableTextIframeBlock = {
			_type: "iframe",
			_key: "frame1",
			src: "https://www.youtube.com/embed/abc",
			title: "Launch video",
			width: 560,
			height: 315,
			allow: "autoplay; encrypted-media",
			allowFullscreen: true,
		};

		const pm = portableTextToProsemirror([block], { preserveIdentity: true });

		expect(pm.content[0]?.type).toBe("iframeBlock");
		expect(prosemirrorToPortableText(pm)).toStrictEqual([block]);
	});

	it("writes only the fields that are set", () => {
		const pt = prosemirrorToPortableText({
			type: "doc",
			content: [
				{
					type: "iframeBlock",
					attrs: {
						src: "https://example.com/map",
						title: "",
						width: null,
						height: "100%",
						allow: "",
						allowFullscreen: false,
					},
				},
			],
		});

		expect(pt).toStrictEqual([
			{ _type: "iframe", _key: expect.any(String), src: "https://example.com/map" },
		]);
	});

	it.each([
		["other fields", { theme: "dark" }],
		["a size that isn't a whole number", { width: "100%", height: "400" }],
		["a title that isn't text", { title: 5 }],
	])("leaves an iframe block with %s to its plugin", (_, fields) => {
		const block = {
			_type: "iframe",
			_key: "plugin1",
			src: "https://example.com/widget",
			...fields,
		};

		const pm = portableTextToProsemirror([block], { preserveIdentity: true });

		expect(pm.content[0]?.type).not.toBe("iframeBlock");
		expect(prosemirrorToPortableText(pm)).toStrictEqual([block]);
	});
});
