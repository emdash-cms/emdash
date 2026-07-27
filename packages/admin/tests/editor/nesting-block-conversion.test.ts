/**
 * The admin editor carries its own Portable Text converters, separate from the ones
 * in @emdash-cms/core, and a save goes through these. Core's round-trip tests do not
 * cover them: an attribute can round-trip in core and still be dropped on every save.
 */

import { describe, it, expect } from "vitest";

import {
	_prosemirrorToPortableText as prosemirrorToPortableText,
	_portableTextToProsemirror as portableTextToProsemirror,
} from "../../src/components/PortableTextEditor";

interface NestingPT {
	_type: string;
	layout?: string;
	gap?: string;
	align?: string;
	widths?: string;
	children?: Array<{ _type: string; children?: unknown[] }>;
}

function column(text: string) {
	return {
		type: "nestingColumn",
		content: [{ type: "paragraph", content: [{ type: "text", text }] }],
	};
}

describe("nesting block round-trip (admin editor seam)", () => {
	it("keeps every layout attribute through PM to PT", () => {
		const [block] = prosemirrorToPortableText({
			type: "doc",
			content: [
				{
					type: "nestingBlock",
					attrs: { layout: "grid", gap: "lg", align: "center", widths: "wide-first" },
					content: [column("left"), column("right")],
				},
			],
		}) as unknown as NestingPT[];

		expect(block).toMatchObject({
			_type: "nestingBlock",
			layout: "grid",
			gap: "lg",
			align: "center",
			widths: "wide-first",
		});
		expect(block.children).toHaveLength(2);
	});

	it("keeps every layout attribute through PT to PM", () => {
		const doc = portableTextToProsemirror([
			{
				_type: "nestingBlock",
				_key: "n1",
				layout: "flex",
				gap: "sm",
				align: "end",
				widths: "narrow-last",
				children: [
					{ _type: "nestingColumn", _key: "c1", children: [] },
					{ _type: "nestingColumn", _key: "c2", children: [] },
				],
			},
		] as never);

		expect(doc.content?.[0]).toMatchObject({
			type: "nestingBlock",
			attrs: { layout: "flex", gap: "sm", align: "end", widths: "narrow-last" },
		});
	});

	it("survives a full PT to PM to PT cycle, which is what a save does", () => {
		const original = {
			_type: "nestingBlock",
			_key: "n1",
			layout: "grid",
			gap: "md",
			align: "start",
			widths: "wide-last",
			children: [
				{ _type: "nestingColumn", _key: "c1", children: [] },
				{ _type: "nestingColumn", _key: "c2", children: [] },
			],
		};

		const roundTripped = prosemirrorToPortableText(
			portableTextToProsemirror([original] as never) as never,
		) as unknown as NestingPT[];

		expect(roundTripped[0]).toMatchObject({
			layout: "grid",
			gap: "md",
			align: "start",
			widths: "wide-last",
		});
	});

	it("falls back to equal for a missing or unrecognised widths value", () => {
		const doc = portableTextToProsemirror([
			{
				_type: "nestingBlock",
				_key: "n1",
				widths: "sideways",
				children: [{ _type: "nestingColumn", _key: "c1", children: [] }],
			},
		] as never);

		expect(doc.content?.[0]).toMatchObject({ attrs: { widths: "equal" } });
	});
});
