import { describe, expect, it } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type { PortableTextBlock } from "../../../src/content/converters/types.js";

describe("Portable Text converter identity preservation", () => {
	it("preserves a payload-less custom block unchanged", () => {
		const blocks: PortableTextBlock[] = [{ _type: "test.divider", _key: "divider-1" }];

		const roundTripped = prosemirrorToPortableText(portableTextToProsemirror(blocks));

		expect(roundTripped).toEqual(blocks);
	});

	it("preserves existing keys and supported link mark definitions", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "block",
				_key: "block-1",
				style: "normal",
				children: [
					{
						_type: "span",
						_key: "span-1",
						text: "Linked text",
						marks: ["strong", "link-1"],
					},
				],
				markDefs: [
					{
						_type: "link",
						_key: "link-1",
						href: "https://example.com",
						blank: true,
					},
				],
			},
		];

		const roundTripped = prosemirrorToPortableText(portableTextToProsemirror(blocks));

		expect(roundTripped).toEqual(blocks);
	});

	it("keeps one span identity across hard breaks", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "block",
				_key: "block-1",
				style: "normal",
				children: [
					{
						_type: "span",
						_key: "span-1",
						text: "First line\nSecond line",
						marks: ["code"],
					},
				],
			},
		];

		const roundTripped = prosemirrorToPortableText(portableTextToProsemirror(blocks));

		expect(roundTripped).toEqual(blocks);
	});

	it("assigns a new key when ProseMirror splits a keyed block", () => {
		const document = portableTextToProsemirror([
			{
				_type: "block",
				_key: "block-1",
				style: "normal",
				children: [{ _type: "span", _key: "span-1", text: "Hello world" }],
			},
		]);
		document.content.push({ ...document.content[0]! });

		const roundTripped = prosemirrorToPortableText(document);
		const keys = roundTripped.map((block) => block._key);

		expect(keys).toContain("block-1");
		expect(new Set(keys).size).toBe(keys.length);
	});
});
