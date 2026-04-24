import { describe, it, expect } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type {
	PortableTextTextBlock,
	ProseMirrorDocument,
} from "../../../src/content/converters/types.js";

describe("textAlign round-trip", () => {
	it("preserves center alignment on a paragraph through PT → PM → PT", () => {
		const block: PortableTextTextBlock = {
			_type: "block",
			_key: "p1",
			style: "normal",
			textAlign: "center",
			children: [{ _type: "span", _key: "s1", text: "Centered" }],
		};

		const pm = portableTextToProsemirror([block]);
		const paragraph = pm.content[0];
		expect(paragraph.type).toBe("paragraph");
		expect(paragraph.attrs?.textAlign).toBe("center");

		const pt = prosemirrorToPortableText(pm);
		const restored = pt[0] as PortableTextTextBlock;
		expect(restored.textAlign).toBe("center");
	});

	it("preserves right alignment on a heading through PT → PM → PT", () => {
		const block: PortableTextTextBlock = {
			_type: "block",
			_key: "h1",
			style: "h1",
			textAlign: "right",
			children: [{ _type: "span", _key: "s1", text: "Right heading" }],
		};

		const pm = portableTextToProsemirror([block]);
		const heading = pm.content[0];
		expect(heading.type).toBe("heading");
		expect(heading.attrs?.level).toBe(1);
		expect(heading.attrs?.textAlign).toBe("right");

		const pt = prosemirrorToPortableText(pm);
		const restored = pt[0] as PortableTextTextBlock;
		expect(restored.style).toBe("h1");
		expect(restored.textAlign).toBe("right");
	});

	it("does not add textAlign to blocks without it", () => {
		const block: PortableTextTextBlock = {
			_type: "block",
			_key: "p1",
			style: "normal",
			children: [{ _type: "span", _key: "s1", text: "Plain" }],
		};

		const pt = prosemirrorToPortableText(portableTextToProsemirror([block]));
		const restored = pt[0] as PortableTextTextBlock;
		expect(restored.textAlign).toBeUndefined();
	});

	it("normalizes explicit left alignment away on save", () => {
		const pm: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					attrs: { textAlign: "left" },
					content: [{ type: "text", text: "Default" }],
				},
			],
		};

		const pt = prosemirrorToPortableText(pm);
		const restored = pt[0] as PortableTextTextBlock;
		expect(restored.textAlign).toBeUndefined();
	});
});
