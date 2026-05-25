import { describe, it, expect } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type { PortableTextTextBlock } from "../../../src/content/converters/types.js";

type PMNode = { type: string; content?: PMNode[] };
type PMList = {
	type: "bulletList" | "orderedList";
	content: Array<{
		type: "listItem";
		content: Array<{ type: string; content?: unknown[] }>;
	}>;
};

function findFirstList(node: { content?: unknown[] }): PMList | null {
	if (!node.content) return null;
	for (const child of node.content as Array<{ type?: string }>) {
		if (child.type === "bulletList" || child.type === "orderedList") return child as PMList;
	}
	return null;
}

function getParagraphText(listItem: { content?: unknown[] }): string | undefined {
	if (!listItem.content) return undefined;
	const para = (listItem.content as Array<{ type?: string; content?: unknown[] }>).find(
		(c) => c.type === "paragraph",
	);
	const text = (para?.content as Array<{ type?: string; text?: string }> | undefined)?.find(
		(c) => c.type === "text",
	);
	return text?.text;
}

function getNestedList(listItem: { content?: unknown[] }): PMList | undefined {
	return (listItem.content as Array<{ type?: string }> | undefined)?.find(
		(c) => c.type === "bulletList" || c.type === "orderedList",
	) as PMList | undefined;
}

function pt(listItem: "bullet" | "number", level: number, text: string): PortableTextTextBlock {
	return {
		_type: "block",
		_key: `b${level}-${text}`,
		style: "normal",
		listItem,
		level,
		children: [{ _type: "span", _key: `s-${text}`, text }],
	};
}

describe("portableTextToProsemirror: list run grouping", () => {
	it("nests level=2 bullets inside their parent listItem", () => {
		const result = portableTextToProsemirror([pt("bullet", 1, "Parent"), pt("bullet", 2, "Child")]);
		const list = findFirstList(result);
		expect(list?.type).toBe("bulletList");
		expect(list?.content).toHaveLength(1);
		expect(getParagraphText(list!.content[0]!)).toBe("Parent");

		const nested = getNestedList(list!.content[0]!);
		expect(nested?.type).toBe("bulletList");
		expect(nested?.content).toHaveLength(1);
		expect(getParagraphText(nested!.content[0]!)).toBe("Child");
	});

	it("keeps a numbered child nested under its bullet parent (mixed type run)", () => {
		// Regression: the outer run-grouping used to break on `listItem`
		// change, so this input would emit one bulletList + one orderedList
		// + one bulletList at the document root instead of one bulletList
		// with an orderedList nested under the first item.
		const result = portableTextToProsemirror([
			pt("bullet", 1, "Parent"),
			pt("number", 2, "Numbered child"),
			pt("bullet", 1, "Sibling"),
		]);
		const lists = (result.content as PMNode[]).filter(
			(c) => c.type === "bulletList" || c.type === "orderedList",
		) as PMList[];
		expect(lists).toHaveLength(1);
		expect(lists[0]!.type).toBe("bulletList");
		expect(lists[0]!.content).toHaveLength(2);
		expect(getParagraphText(lists[0]!.content[0]!)).toBe("Parent");
		expect(getParagraphText(lists[0]!.content[1]!)).toBe("Sibling");
		expect(getNestedList(lists[0]!.content[0]!)?.type).toBe("orderedList");
		expect(getNestedList(lists[0]!.content[1]!)).toBeUndefined();
	});

	it("still ends the run on a different-type level=1 sibling", () => {
		// `[bullet L1, bullet L1, number L1]` is three siblings where the
		// number is a separate top-level list — keep that behavior intact.
		const result = portableTextToProsemirror([
			pt("bullet", 1, "A"),
			pt("bullet", 1, "B"),
			pt("number", 1, "C"),
		]);
		const lists = (result.content as PMNode[]).filter(
			(c) => c.type === "bulletList" || c.type === "orderedList",
		) as PMList[];
		expect(lists.map((l) => l.type)).toEqual(["bulletList", "orderedList"]);
		expect(lists[0]!.content).toHaveLength(2);
		expect(lists[1]!.content).toHaveLength(1);
		expect(getParagraphText(lists[1]!.content[0]!)).toBe("C");
	});

	it("handles three-level nesting with type switches", () => {
		const result = portableTextToProsemirror([
			pt("bullet", 1, "L1"),
			pt("number", 2, "L2"),
			pt("bullet", 3, "L3"),
		]);
		const l1 = findFirstList(result);
		expect(l1?.type).toBe("bulletList");
		expect(getParagraphText(l1!.content[0]!)).toBe("L1");

		const l2 = getNestedList(l1!.content[0]!);
		expect(l2?.type).toBe("orderedList");
		expect(getParagraphText(l2!.content[0]!)).toBe("L2");

		const l3 = getNestedList(l2!.content[0]!);
		expect(l3?.type).toBe("bulletList");
		expect(getParagraphText(l3!.content[0]!)).toBe("L3");
	});

	it("keeps deeper nesting under its true parent for mixed-type 3-level trees", () => {
		// Regression for convertListItem's nested grouping: it used to break
		// the group on every `listItem` change regardless of depth, so a
		// level-3 block ended up as a sibling sub-list under the level-1
		// item instead of nesting under the matching level-2 item — and the
		// round-trip would degrade level-3 to level-2.
		const original = [
			pt("bullet", 1, "A"),
			pt("number", 2, "B"),
			pt("bullet", 3, "C"),
			pt("number", 2, "D"),
		];
		const pm = portableTextToProsemirror(original);

		const outer = findFirstList(pm);
		expect(outer?.type).toBe("bulletList");
		expect(outer?.content).toHaveLength(1);
		expect(getParagraphText(outer!.content[0]!)).toBe("A");

		const numbered = getNestedList(outer!.content[0]!);
		expect(numbered?.type).toBe("orderedList");
		expect(numbered?.content).toHaveLength(2);
		expect(getParagraphText(numbered!.content[0]!)).toBe("B");
		expect(getParagraphText(numbered!.content[1]!)).toBe("D");

		const cInBullets = getNestedList(numbered!.content[0]!);
		expect(cInBullets?.type).toBe("bulletList");
		expect(getParagraphText(cInBullets!.content[0]!)).toBe("C");

		// Round-trip must keep C at level 3, not collapse it to level 2.
		const roundTripped = prosemirrorToPortableText(pm).filter(
			(b): b is PortableTextTextBlock =>
				typeof b === "object" && b !== null && (b as { _type?: string })._type === "block",
		);
		expect(roundTripped.map((b) => [b.listItem, b.level, b.children[0]?.text])).toEqual([
			["bullet", 1, "A"],
			["number", 2, "B"],
			["bullet", 3, "C"],
			["number", 2, "D"],
		]);
	});

	it("round-trips PT → PM → PT preserving level and listItem in a mixed-type tree", () => {
		const original = [
			pt("bullet", 1, "Top"),
			pt("number", 2, "Nested"),
			pt("bullet", 1, "Sibling"),
		];
		const pm = portableTextToProsemirror(original);
		const roundTripped = prosemirrorToPortableText(pm).filter(
			(b): b is PortableTextTextBlock =>
				typeof b === "object" && b !== null && (b as { _type?: string })._type === "block",
		);
		expect(roundTripped.map((b) => [b.listItem, b.level, b.children[0]?.text])).toEqual([
			["bullet", 1, "Top"],
			["number", 2, "Nested"],
			["bullet", 1, "Sibling"],
		]);
	});
});
