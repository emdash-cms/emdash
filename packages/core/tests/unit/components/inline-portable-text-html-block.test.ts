/**
 * Inline editor htmlBlock round-trip tests.
 *
 * Tests the Portable Text ↔ ProseMirror conversion for `htmlBlock` through
 * the seams the inline (visual-editing) editor actually exercises. Mirrors the
 * core converter round-trip test against the in-file converters.
 */

import { describe, it, expect } from "vitest";

import {
	_pmToPortableText as pmToPortableText,
	_portableTextToPM as portableTextToPM,
} from "../../../src/components/InlinePortableTextEditor.js";

describe("HTML block round-trip (inline editor seam)", () => {
	it("preserves html content through PT → PM → PT", () => {
		const htmlBlock = {
			_type: "htmlBlock",
			_key: "html001",
			html: '<div class="callout"><p>Hello <strong>world</strong></p></div>',
		};

		const pm = portableTextToPM([htmlBlock]);
		const node = pm.content?.[0] as { type: string; attrs?: { html?: string } };

		expect(node.type).toBe("htmlBlock");
		expect(node.attrs?.html).toBe(htmlBlock.html);

		const pt = pmToPortableText(pm);
		const restored = pt[0] as { _type: string; _key?: string; html?: string };

		expect(restored._type).toBe("htmlBlock");
		expect(restored.html).toBe(htmlBlock.html);
		expect(restored._key).toBeTruthy();
	});

	it("handles empty html content", () => {
		const emptyBlock = { _type: "htmlBlock", _key: "html002", html: "" };

		const pm = portableTextToPM([emptyBlock]);
		const node = pm.content?.[0] as { type: string; attrs?: { html?: string } };

		expect(node.type).toBe("htmlBlock");
		expect(node.attrs?.html).toBe("");

		const pt = pmToPortableText(pm);
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

		const pm = portableTextToPM(blocks);
		expect(pm.content).toHaveLength(3);
		const middle = pm.content?.[1] as { type: string } | undefined;
		expect(middle?.type).toBe("htmlBlock");

		const pt = pmToPortableText(pm);
		expect(pt).toHaveLength(3);
		expect(pt[1]!._type).toBe("htmlBlock");
		expect((pt[1] as { html?: string }).html).toBe("<hr><p>Injected</p>");
	});
});
