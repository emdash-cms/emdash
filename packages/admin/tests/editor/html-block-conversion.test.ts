/**
 * HTML Block Conversion Tests (admin editor seam)
 *
 * Tests the Portable Text ↔ ProseMirror conversion for `htmlBlock` through
 * the seams the admin rich-text editor actually exercises. Mirrors the core
 * converter round-trip test against the in-file converters.
 */

import { describe, it, expect } from "vitest";

import {
	_prosemirrorToPortableText as prosemirrorToPortableText,
	_portableTextToProsemirror as portableTextToProsemirror,
} from "../../src/components/PortableTextEditor";

describe("HTML block round-trip (admin editor seam)", () => {
	it("preserves html content through PT → PM → PT", () => {
		const htmlBlock = {
			_type: "htmlBlock",
			_key: "html001",
			html: '<div class="callout"><p>Hello <strong>world</strong></p></div>',
		};

		const pm = portableTextToProsemirror([htmlBlock]);
		const node = pm.content?.[0] as { type: string; attrs?: { html?: string } };

		expect(node.type).toBe("htmlBlock");
		expect(node.attrs?.html).toBe(htmlBlock.html);

		const pt = prosemirrorToPortableText(pm);
		const restored = pt[0] as { _type: string; _key?: string; html?: string };

		expect(restored._type).toBe("htmlBlock");
		expect(restored.html).toBe(htmlBlock.html);
		expect(restored._key).toBeTruthy();
	});

	it("handles empty html content", () => {
		const emptyBlock = { _type: "htmlBlock", _key: "html002", html: "" };

		const pm = portableTextToProsemirror([emptyBlock]);
		const node = pm.content?.[0] as { type: string; attrs?: { html?: string } };

		expect(node.type).toBe("htmlBlock");
		expect(node.attrs?.html).toBe("");

		const pt = prosemirrorToPortableText(pm);
		const restored = pt[0] as { _type: string; html?: string };

		expect(restored._type).toBe("htmlBlock");
		expect(restored.html).toBe("");
	});

	it("preserves html blocks among other block types", () => {
		const blocks = [
			{
				_type: "block",
				_key: "txt001",
				style: "normal",
				children: [{ _type: "span", _key: "s1", text: "Before" }],
			},
			{ _type: "htmlBlock", _key: "html003", html: "<hr><p>Injected</p>" },
			{
				_type: "block",
				_key: "txt002",
				style: "normal",
				children: [{ _type: "span", _key: "s2", text: "After" }],
			},
		];

		const pm = portableTextToProsemirror(blocks);
		expect(pm.content).toHaveLength(3);
		const middle = pm.content?.[1] as { type: string } | undefined;
		expect(middle?.type).toBe("htmlBlock");

		const pt = prosemirrorToPortableText(pm);
		expect(pt).toHaveLength(3);
		expect(pt[1]!._type).toBe("htmlBlock");
		expect((pt[1] as { html?: string }).html).toBe("<hr><p>Injected</p>");
	});
});
