/**
 * Text alignment round-trip tests for the admin editor's inlined
 * ProseMirror ↔ Portable Text converters.
 *
 * Mirrors packages/core/tests/unit/converters/text-alignment.test.ts against
 * core's shared converters; the admin has its own duplicate pair today.
 */

import { describe, it, expect } from "vitest";

import {
	_prosemirrorToPortableText as prosemirrorToPortableText,
	_portableTextToProsemirror as portableTextToProsemirror,
} from "../../src/components/PortableTextEditor";

describe("admin editor: textAlign round-trip", () => {
	it("preserves center alignment on a paragraph through PT → PM → PT", () => {
		const block = {
			_type: "block",
			_key: "p1",
			style: "normal",
			textAlign: "center",
			children: [{ _type: "span", _key: "s1", text: "Centered" }],
		} as const;

		const pm = portableTextToProsemirror([block]);
		const paragraph = pm.content?.[0] as { type: string; attrs?: { textAlign?: string } };
		expect(paragraph.type).toBe("paragraph");
		expect(paragraph.attrs?.textAlign).toBe("center");

		const pt = prosemirrorToPortableText(pm);
		expect((pt[0] as { textAlign?: string }).textAlign).toBe("center");
	});

	it("preserves right alignment on a heading through PT → PM → PT", () => {
		const block = {
			_type: "block",
			_key: "h1",
			style: "h1",
			textAlign: "right",
			children: [{ _type: "span", _key: "s1", text: "Right heading" }],
		} as const;

		const pm = portableTextToProsemirror([block]);
		const heading = pm.content?.[0] as {
			type: string;
			attrs?: { level?: number; textAlign?: string };
		};
		expect(heading.type).toBe("heading");
		expect(heading.attrs?.level).toBe(1);
		expect(heading.attrs?.textAlign).toBe("right");

		const pt = prosemirrorToPortableText(pm);
		const restored = pt[0] as { style?: string; textAlign?: string };
		expect(restored.style).toBe("h1");
		expect(restored.textAlign).toBe("right");
	});

	it("does not add textAlign to blocks without it", () => {
		const block = {
			_type: "block",
			_key: "p1",
			style: "normal",
			children: [{ _type: "span", _key: "s1", text: "Plain" }],
		} as const;

		const pt = prosemirrorToPortableText(portableTextToProsemirror([block]));
		expect((pt[0] as { textAlign?: string }).textAlign).toBeUndefined();
	});

	it("normalizes explicit left alignment away on save", () => {
		const pm = {
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
		expect((pt[0] as { textAlign?: string }).textAlign).toBeUndefined();
	});
});
