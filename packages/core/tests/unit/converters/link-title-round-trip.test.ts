import { describe, expect, it } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type {
	PortableTextLinkMark,
	PortableTextTextBlock,
} from "../../../src/content/converters/types.js";

describe("link title round-trip (core converters)", () => {
	it("keeps a title stored on a link markDef through PT → PM → PT", () => {
		const pt = [
			{
				_type: "block",
				_key: "b1",
				style: "normal",
				markDefs: [
					{
						_type: "link",
						_key: "l1",
						href: "https://example.com/john-3-16",
						title: "For God so loved the world",
					},
				],
				children: [{ _type: "span", _key: "s1", text: "John 3:16", marks: ["l1"] }],
			},
		] as PortableTextTextBlock[];

		const restored = prosemirrorToPortableText(
			portableTextToProsemirror(pt, { preserveIdentity: true }),
		);
		const block = restored[0] as PortableTextTextBlock;
		const link = block.markDefs?.find((m) => m._type === "link") as
			| (PortableTextLinkMark & { title?: string })
			| undefined;
		expect(link?.href).toBe("https://example.com/john-3-16");
		expect(link?.title).toBe("For God so loved the world");
	});
});
