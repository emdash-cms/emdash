import { describe, it, expect } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type {
	ProseMirrorDocument,
	PortableTextTextBlock,
} from "../../../src/content/converters/types.js";

describe("Text alignment round-trip (core converters)", () => {
	it("preserves paragraph textAlign through PM → PT → PM", () => {
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					attrs: { textAlign: "center" },
					content: [{ type: "text", text: "Centered" }],
				},
			],
		};

		// PM → PT
		const pt = prosemirrorToPortableText(doc);
		const block = pt[0] as PortableTextTextBlock;
		expect(block._type).toBe("block");
		expect(block.textAlign).toBe("center");

		// PT → PM
		const pm = portableTextToProsemirror(pt);
		expect(pm.content[0].type).toBe("paragraph");
		expect(pm.content[0].attrs?.textAlign).toBe("center");
	});

	it("preserves heading textAlign through PM → PT → PM", () => {
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "heading",
					attrs: { level: 2, textAlign: "right" },
					content: [{ type: "text", text: "Right heading" }],
				},
			],
		};

		const pt = prosemirrorToPortableText(doc);
		const block = pt[0] as PortableTextTextBlock;
		expect(block.style).toBe("h2");
		expect(block.textAlign).toBe("right");

		const pm = portableTextToProsemirror(pt);
		expect(pm.content[0].type).toBe("heading");
		expect(pm.content[0].attrs?.level).toBe(2);
		expect(pm.content[0].attrs?.textAlign).toBe("right");
	});

	it("does not add textAlign for default-aligned (left / unset) content", () => {
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{ type: "paragraph", attrs: { textAlign: "left" }, content: [{ type: "text", text: "A" }] },
				{ type: "paragraph", content: [{ type: "text", text: "B" }] },
			],
		};

		const pt = prosemirrorToPortableText(doc);
		expect((pt[0] as PortableTextTextBlock).textAlign).toBeUndefined();
		expect((pt[1] as PortableTextTextBlock).textAlign).toBeUndefined();

		// PT without textAlign must not emit the attr back into PM
		const pm = portableTextToProsemirror(pt);
		expect(pm.content[0].attrs?.textAlign).toBeUndefined();
	});
});
