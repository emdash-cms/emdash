import { describe, it, expect } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type { PortableTextHtmlBlock } from "../../../src/content/converters/types.js";

describe("HTML block round-trip (core converters)", () => {
	it("preserves html content through PT → PM → PT", () => {
		const htmlBlock: PortableTextHtmlBlock = {
			_type: "htmlBlock",
			_key: "html001",
			html: '<div class="callout"><p>Hello <strong>world</strong></p></div>',
		};

		// PT → PM
		const pm = portableTextToProsemirror([htmlBlock]);
		const node = pm.content[0];

		expect(node).toBeDefined();
		expect(node.type).toBe("htmlBlock");
		expect(node.attrs?.html).toBe(htmlBlock.html);

		// PM → PT
		const pt = prosemirrorToPortableText(pm);
		const restored = pt[0] as PortableTextHtmlBlock;

		expect(restored._type).toBe("htmlBlock");
		expect(restored.html).toBe(htmlBlock.html);
		expect(restored._key).toBeDefined();
	});

	it("handles empty html content", () => {
		const emptyBlock: PortableTextHtmlBlock = {
			_type: "htmlBlock",
			_key: "html002",
			html: "",
		};

		const pm = portableTextToProsemirror([emptyBlock]);
		const node = pm.content[0];

		expect(node).toBeDefined();
		expect(node.type).toBe("htmlBlock");
		expect(node.attrs?.html).toBe("");

		const pt = prosemirrorToPortableText(pm);
		const restored = pt[0] as PortableTextHtmlBlock;

		expect(restored._type).toBe("htmlBlock");
		expect(restored.html).toBe("");
	});

	it("preserves html blocks among other block types", () => {
		const blocks = [
			{
				_type: "block" as const,
				_key: "txt001",
				style: "normal" as const,
				children: [{ _type: "span" as const, _key: "s1", text: "Before" }],
			},
			{
				_type: "htmlBlock" as const,
				_key: "html003",
				html: "<hr><p>Injected</p>",
			},
			{
				_type: "block" as const,
				_key: "txt002",
				style: "normal" as const,
				children: [{ _type: "span" as const, _key: "s2", text: "After" }],
			},
		];

		const pm = portableTextToProsemirror(blocks);
		expect(pm.content).toHaveLength(3);
		expect(pm.content[0].type).toBe("paragraph");
		expect(pm.content[1].type).toBe("htmlBlock");
		expect(pm.content[2].type).toBe("paragraph");

		const pt = prosemirrorToPortableText(pm);
		expect(pt).toHaveLength(3);
		expect(pt[0]._type).toBe("block");
		expect(pt[1]._type).toBe("htmlBlock");
		expect((pt[1] as PortableTextHtmlBlock).html).toBe("<hr><p>Injected</p>");
		expect(pt[2]._type).toBe("block");
	});
});
