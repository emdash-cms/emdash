import { describe, expect, it } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type {
	PortableTextTextBlock,
	ProseMirrorDocument,
} from "../../../src/content/converters/types.js";

describe("unsupported Portable Text marks (core converters)", () => {
	it("rejects every unsupported decorator spanning nested blocks without dropping supported marks", () => {
		const blocks: PortableTextTextBlock[] = [
			{
				_type: "block",
				_key: "quote",
				style: "blockquote",
				children: [
					{ _type: "span", _key: "s1", text: "Brand", marks: ["strong", "accent"] },
					{ _type: "span", _key: "s2", text: " voice", marks: ["accent", "em"] },
				],
			},
			{
				_type: "block",
				_key: "nested-list",
				style: "normal",
				listItem: "bullet",
				level: 2,
				children: [{ _type: "span", _key: "s3", text: "Muted", marks: ["subtle", "code"] }],
			},
		];

		expect(() => portableTextToProsemirror(blocks)).toThrow(/accent.*subtle/);
	});

	it("rejects unsupported markDefs annotations by type instead of their opaque keys", () => {
		const blocks: PortableTextTextBlock[] = [
			{
				_type: "block",
				_key: "b1",
				style: "normal",
				markDefs: [{ _type: "brandColor", _key: "annotation-9f31", token: "accent" }],
				children: [
					{
						_type: "span",
						_key: "s1",
						text: "Highlighted",
						marks: ["strong", "annotation-9f31"],
					},
				],
			},
		];

		let conversionError: Error | undefined;
		try {
			portableTextToProsemirror(blocks);
		} catch (error) {
			conversionError = error as Error;
		}
		expect(conversionError?.message).toContain("brandColor");
		expect(conversionError?.message).not.toContain("annotation-9f31");
	});

	it("rejects unsupported ProseMirror marks anywhere in the outbound document", () => {
		const document: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "blockquote",
					content: [
						{
							type: "paragraph",
							content: [
								{
									type: "text",
									text: "Mixed",
									marks: [{ type: "bold" }, { type: "accent" }],
								},
								{
									type: "text",
									text: " marks",
									marks: [{ type: "italic" }, { type: "subtle" }],
								},
							],
						},
					],
				},
			],
		};

		expect(() => prosemirrorToPortableText(document)).toThrow(/accent.*subtle/);
	});

	it("round-trips every supported decorator and link annotation", () => {
		const blocks: PortableTextTextBlock[] = [
			{
				_type: "block",
				_key: "b1",
				style: "normal",
				markDefs: [{ _type: "link", _key: "link-1", href: "https://example.com" }],
				children: [
					{
						_type: "span",
						_key: "s1",
						text: "Supported",
						marks: [
							"strong",
							"em",
							"underline",
							"strike-through",
							"subscript",
							"superscript",
							"code",
							"link-1",
						],
					},
				],
			},
		];

		const roundTripped = prosemirrorToPortableText(portableTextToProsemirror(blocks));
		const block = roundTripped[0] as PortableTextTextBlock;
		const spanMarks = block.children[0]?.marks ?? [];
		const linkDef = block.markDefs?.find((markDef) => markDef._type === "link");

		expect(spanMarks).toEqual(
			expect.arrayContaining([
				"strong",
				"em",
				"underline",
				"strike-through",
				"subscript",
				"superscript",
				"code",
			]),
		);
		expect(linkDef).toMatchObject({ _type: "link", href: "https://example.com" });
		expect(spanMarks).toContain(linkDef?._key);
	});
});
