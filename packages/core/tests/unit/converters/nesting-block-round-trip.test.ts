import { describe, it, expect } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type {
	PortableTextNestingBlock,
	PortableTextNestingColumn,
	PortableTextTextBlock,
} from "../../../src/content/converters/types.js";

function paragraph(key: string, text: string): PortableTextTextBlock {
	return {
		_type: "block",
		_key: key,
		style: "normal",
		children: [{ _type: "span", _key: `${key}-s`, text }],
	};
}

function column(key: string, ...blocks: PortableTextTextBlock[]): PortableTextNestingColumn {
	return { _type: "nestingColumn", _key: key, children: blocks };
}

describe("Nesting block round-trip (core converters)", () => {
	it("preserves layout attrs and columns through PT → PM → PT", () => {
		const nesting: PortableTextNestingBlock = {
			_type: "nestingBlock",
			_key: "nest001",
			layout: "grid",
			columns: 2,
			gap: "lg",
			align: "center",
			children: [column("col1", paragraph("c1", "Left")), column("col2", paragraph("c2", "Right"))],
		};

		const pm = portableTextToProsemirror([nesting]);
		const node = pm.content[0];

		expect(node.type).toBe("nestingBlock");
		expect(node.attrs).toMatchObject({ layout: "grid", columns: 2, gap: "lg", align: "center" });
		expect(node.content).toHaveLength(2);
		expect(node.content?.[0].type).toBe("nestingColumn");
		expect(node.content?.[0].content?.[0].type).toBe("paragraph");

		const pt = prosemirrorToPortableText(pm);
		const restored = pt[0] as PortableTextNestingBlock;

		expect(restored._type).toBe("nestingBlock");
		expect(restored).toMatchObject({ layout: "grid", columns: 2, gap: "lg", align: "center" });
		expect(restored.children).toHaveLength(2);
		expect(restored.children[0]._type).toBe("nestingColumn");
		const firstBlock = restored.children[0].children[0] as PortableTextTextBlock;
		expect(firstBlock.children[0].text).toBe("Left");
	});

	it("derives `columns` from the column count", () => {
		const nesting: PortableTextNestingBlock = {
			_type: "nestingBlock",
			_key: "n",
			layout: "grid",
			columns: 99, // stale/wrong on purpose
			gap: "md",
			align: "start",
			children: [
				column("a", paragraph("a1", "x")),
				column("b", paragraph("b1", "y")),
				column("c", paragraph("c1", "z")),
			],
		};

		const restored = prosemirrorToPortableText(
			portableTextToProsemirror([nesting]),
		)[0] as PortableTextNestingBlock;
		expect(restored.columns).toBe(3);
	});

	it("round-trips a nesting block nested inside a column", () => {
		const inner: PortableTextNestingBlock = {
			_type: "nestingBlock",
			_key: "inner",
			layout: "flex",
			columns: 1,
			gap: "sm",
			align: "stretch",
			children: [column("ic", paragraph("i1", "Deep"))],
		};
		const outer: PortableTextNestingBlock = {
			_type: "nestingBlock",
			_key: "outer",
			layout: "grid",
			columns: 1,
			gap: "md",
			align: "start",
			children: [
				column("oc", paragraph("o1", "Shallow"), inner as unknown as PortableTextTextBlock),
			],
		};

		const pt = prosemirrorToPortableText(portableTextToProsemirror([outer]));
		const restoredOuter = pt[0] as PortableTextNestingBlock;
		const outerCol = restoredOuter.children[0];
		const restoredInner = outerCol.children[1] as unknown as PortableTextNestingBlock;

		expect(restoredInner._type).toBe("nestingBlock");
		expect(restoredInner.layout).toBe("flex");
		const deep = restoredInner.children[0].children[0] as PortableTextTextBlock;
		expect(deep.children[0].text).toBe("Deep");
	});

	it("gives an empty container a column so it stays valid", () => {
		const empty = {
			_type: "nestingBlock",
			_key: "nest-empty",
			layout: "grid",
			columns: 2,
			gap: "md",
			align: "start",
			children: [],
		} as unknown as PortableTextNestingBlock;

		const pm = portableTextToProsemirror([empty]);
		expect(pm.content[0].content).toHaveLength(1);
		expect(pm.content[0].content?.[0].type).toBe("nestingColumn");
	});
});
