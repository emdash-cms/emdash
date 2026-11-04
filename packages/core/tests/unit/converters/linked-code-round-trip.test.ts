import { describe, it, expect } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type {
	PortableTextLinkMark,
	PortableTextTextBlock,
} from "../../../src/content/converters/types.js";

describe("linked inline code round-trip (core converters)", () => {
	it("preserves code + link marks on body text through PT → PM → PT", () => {
		const pt: PortableTextTextBlock[] = [
			{
				_type: "block",
				_key: "b1",
				style: "normal",
				markDefs: [
					{
						_type: "link",
						_key: "l1",
						href: "https://example.com/fetch",
					},
				],
				children: [
					{
						_type: "span",
						_key: "s1",
						text: "fetch",
						marks: ["code", "l1"],
					},
				],
			},
		];

		const pm = portableTextToProsemirror(pt);
		const textNode = pm.content[0]?.content?.[0];
		expect(textNode?.type).toBe("text");
		expect(textNode?.text).toBe("fetch");
		const markTypes = (textNode?.marks ?? []).map((m) => m.type).toSorted();
		expect(markTypes).toEqual(["code", "link"]);
		expect(textNode?.marks?.find((m) => m.type === "link")?.attrs?.href).toBe(
			"https://example.com/fetch",
		);

		const restored = prosemirrorToPortableText(pm);
		expect(restored).toHaveLength(1);
		const block = restored[0] as PortableTextTextBlock;
		expect(block.style).toBe("normal");
		const span = block.children[0];
		expect(span?.text).toBe("fetch");
		expect(span?.marks).toContain("code");
		const linkDef = block.markDefs?.find((d) => d._type === "link") as
			| PortableTextLinkMark
			| undefined;
		expect(linkDef?.href).toBe("https://example.com/fetch");
		expect(span?.marks).toContain(linkDef?._key);
	});

	it("preserves code + link marks on headings through PT → PM → PT", () => {
		const pt: PortableTextTextBlock[] = [
			{
				_type: "block",
				_key: "b1",
				style: "h2",
				markDefs: [
					{
						_type: "link",
						_key: "l1",
						href: "https://react.dev/reference/react/useState",
					},
				],
				children: [
					{
						_type: "span",
						_key: "s1",
						text: "useState",
						marks: ["code", "l1"],
					},
				],
			},
		];

		const pm = portableTextToProsemirror(pt);
		expect(pm.content[0]?.type).toBe("heading");
		expect(pm.content[0]?.attrs?.level).toBe(2);
		const textNode = pm.content[0]?.content?.[0];
		const markTypes = (textNode?.marks ?? []).map((m) => m.type).toSorted();
		expect(markTypes).toEqual(["code", "link"]);

		const restored = prosemirrorToPortableText(pm);
		const block = restored[0] as PortableTextTextBlock;
		expect(block.style).toBe("h2");
		const span = block.children[0];
		expect(span?.marks).toContain("code");
		const linkDef = block.markDefs?.find((d) => d._type === "link") as
			| PortableTextLinkMark
			| undefined;
		expect(linkDef?.href).toBe("https://react.dev/reference/react/useState");
		expect(span?.marks).toContain(linkDef?._key);
	});
});
