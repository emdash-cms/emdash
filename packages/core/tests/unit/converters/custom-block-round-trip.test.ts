import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

import {
	attrsWithPortableTextKey,
	portableTextIdentityExtensions,
} from "../../../src/content/converters/portable-text-identity.js";
import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type { PortableTextBlock } from "../../../src/content/converters/types.js";

function portableTextToIdentityDocument(blocks: PortableTextBlock[]) {
	return portableTextToProsemirror(blocks, { preserveIdentity: true });
}

describe("Portable Text converter identity preservation", () => {
	it("emits text JSON that survives a standard ProseMirror schema", () => {
		const document = portableTextToProsemirror([
			{
				_type: "block",
				_key: "block-1",
				style: "normal",
				children: [{ _type: "span", _key: "span-1", text: "Hello world" }],
			},
		]);
		const schema = getSchema([StarterKit]);

		const parsed = schema.nodeFromJSON(document);

		expect(parsed.toJSON()).toEqual(JSON.parse(JSON.stringify(document)));
	});

	it("uses standard-schema nodes for custom blocks by default", () => {
		const document = portableTextToProsemirror([{ _type: "test.divider", _key: "divider-1" }]);
		const schema = getSchema([StarterKit]);

		expect(() => schema.nodeFromJSON(document)).not.toThrow();
	});

	it("preserves identities through the matching ProseMirror extensions", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "block",
				_key: "block-1",
				style: "normal",
				children: [
					{
						_type: "span",
						_key: "span-1",
						text: "Hello world",
						marks: ["link-1"],
					},
				],
				markDefs: [
					{
						_type: "link",
						_key: "link-1",
						href: "https://example.com",
					},
				],
			},
			{ _type: "test.divider", _key: "divider-1" },
		];
		const schema = getSchema([StarterKit, ...portableTextIdentityExtensions]);
		const document = portableTextToIdentityDocument(blocks);

		const parsed = schema.nodeFromJSON(document);
		const roundTripped = prosemirrorToPortableText(parsed.toJSON());

		expect(roundTripped).toEqual(blocks);
	});

	it("preserves a payload-less custom block unchanged", () => {
		const blocks: PortableTextBlock[] = [{ _type: "test.divider", _key: "divider-1" }];

		const roundTripped = prosemirrorToPortableText(portableTextToIdentityDocument(blocks));

		expect(roundTripped).toEqual(blocks);
	});

	it("preserves a gallery block that has no images array in identity mode", () => {
		const blocks: PortableTextBlock[] = [
			{ _type: "gallery", _key: "gallery-1", legacySource: "import" },
		];

		const roundTripped = prosemirrorToPortableText(portableTextToIdentityDocument(blocks));

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

		const roundTripped = prosemirrorToPortableText(portableTextToIdentityDocument(blocks));

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

		const roundTripped = prosemirrorToPortableText(portableTextToIdentityDocument(blocks));

		expect(roundTripped).toEqual(blocks);
	});

	it("reads a block key from a blockquote wrapper", () => {
		const blocks = prosemirrorToPortableText({
			type: "doc",
			content: [
				{
					type: "blockquote",
					attrs: attrsWithPortableTextKey(undefined, "quote-1"),
					content: [
						{
							type: "paragraph",
							content: [{ type: "text", text: "Quoted text" }],
						},
					],
				},
			],
		});

		expect(blocks[0]).toMatchObject({ _type: "block", _key: "quote-1", style: "blockquote" });
	});

	it("assigns a new key when ProseMirror splits a keyed block", () => {
		const document = portableTextToIdentityDocument([
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
