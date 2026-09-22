import { describe, expect, it } from "vitest";

import { _portableTextToPM as inlinePortableTextToPM } from "../../../src/components/InlinePortableTextEditor.js";
import {
	MAX_ORDERED_LIST_START,
	normalizeListId,
	normalizeListStart,
} from "../../../src/content/converters/numbered-list.js";
import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type {
	PortableTextBlock,
	PortableTextTextBlock,
	ProseMirrorDocument,
	ProseMirrorNode,
} from "../../../src/content/converters/types.js";

function listItem(text: string): ProseMirrorNode {
	return {
		type: "listItem",
		content: [{ type: "paragraph", content: [{ type: "text", text }] }],
	};
}

function ptListItem(
	key: string,
	text: string,
	listId: string,
	listStart = 1,
): PortableTextTextBlock {
	return {
		_type: "block",
		_key: key,
		style: "normal",
		listItem: "number",
		level: 1,
		listId,
		listStart,
		children: [{ _type: "span", _key: `${key}-span`, text }],
	};
}

function paragraph(key: string, text: string): PortableTextTextBlock {
	return {
		_type: "block",
		_key: key,
		style: "normal",
		children: [{ _type: "span", _key: `${key}-span`, text }],
	};
}

function orderedLists(doc: ProseMirrorDocument): ProseMirrorNode[] {
	return doc.content.filter((node) => node.type === "orderedList");
}

function allOrderedLists(doc: ProseMirrorDocument): ProseMirrorNode[] {
	const lists: ProseMirrorNode[] = [];
	const visit = (node: ProseMirrorNode) => {
		if (node.type === "orderedList") lists.push(node);
		node.content?.forEach(visit);
	};
	doc.content.forEach(visit);
	return lists;
}

describe("numbered-list Portable Text conversion", () => {
	it("keeps the inline and reusable legacy identities equivalent", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "block",
				_key: "legacy-item",
				style: "normal",
				listItem: "number",
				level: 1,
				children: [{ _type: "span", _key: "legacy-span", text: "Legacy" }],
			},
		];
		const inline = inlinePortableTextToPM(blocks) as ProseMirrorDocument;
		const reusable = portableTextToProsemirror(blocks);

		expect(allOrderedLists(inline)[0]?.attrs?.listId).toBe(
			allOrderedLists(reusable)[0]?.attrs?.listId,
		);
	});

	it("preserves an explicitly started ProseMirror list through PT", () => {
		const original: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "orderedList",
					attrs: { start: 2 },
					content: [listItem("Second"), listItem("Third")],
				},
			],
		};

		const portableText = prosemirrorToPortableText(original) as PortableTextTextBlock[];
		expect(portableText).toHaveLength(2);
		expect(portableText[0]?.listStart).toBe(2);
		expect(portableText[0]?.listId).toBeTruthy();
		expect(portableText[1]?.listId).toBe(portableText[0]?.listId);

		const roundTripped = portableTextToProsemirror(portableText);
		expect(orderedLists(roundTripped)[0]?.attrs).toMatchObject({
			start: 2,
			listStart: 2,
			listId: portableText[0]?.listId,
		});
	});

	it("derives the later start for separated segments with one identity", () => {
		const blocks: PortableTextBlock[] = [
			ptListItem("a1", "One", "list-a"),
			ptListItem("a2", "Two", "list-a"),
			paragraph("aside", "Between"),
			ptListItem("a3", "Three", "list-a"),
			ptListItem("a4", "Four", "list-a"),
		];

		const lists = orderedLists(portableTextToProsemirror(blocks));
		expect(lists).toHaveLength(2);
		expect(lists[0]?.attrs).toMatchObject({ start: 1, listStart: 1, listId: "list-a" });
		expect(lists[1]?.attrs).toMatchObject({ start: 3, listStart: 1, listId: "list-a" });
	});

	it("does not merge adjacent numbered runs with different identities", () => {
		const blocks: PortableTextBlock[] = [
			ptListItem("a", "First", "list-a"),
			ptListItem("b", "Independent", "list-b"),
		];

		const lists = orderedLists(portableTextToProsemirror(blocks));
		expect(lists).toHaveLength(2);
		expect(lists.map((list) => list.attrs?.listId)).toEqual(["list-a", "list-b"]);
		expect(lists.map((list) => list.attrs?.start)).toEqual([1, 1]);
	});

	it("keeps legacy separated runs independent", () => {
		const blocks: PortableTextBlock[] = [
			{ ...ptListItem("a", "One", "unused"), listId: undefined, listStart: undefined },
			paragraph("aside", "Between"),
			{ ...ptListItem("b", "One again", "unused"), listId: undefined, listStart: undefined },
		];

		const lists = orderedLists(portableTextToProsemirror(blocks));
		expect(lists).toHaveLength(2);
		expect(lists[0]?.attrs?.start).toBe(1);
		expect(lists[1]?.attrs?.start).toBe(1);
		expect(lists[0]?.attrs?.listId).not.toBe(lists[1]?.attrs?.listId);
	});

	it("uses the first valid base for conflicting metadata", () => {
		const blocks: PortableTextBlock[] = [
			ptListItem("a", "Five", "list-a", 5),
			paragraph("aside", "Between"),
			ptListItem("b", "Six", "list-a", 99),
		];

		const lists = orderedLists(portableTextToProsemirror(blocks));
		expect(lists.map((list) => list.attrs?.listStart)).toEqual([5, 5]);
		expect(lists.map((list) => list.attrs?.start)).toEqual([5, 6]);
	});

	it("uses a later valid base when an earlier segment has no base", () => {
		const blocks: PortableTextBlock[] = [
			{ ...ptListItem("a", "Five", "list-a"), listStart: undefined },
			paragraph("aside", "Between"),
			ptListItem("b", "Six", "list-a", 5),
		];

		const lists = orderedLists(portableTextToProsemirror(blocks));
		expect(lists.map((list) => list.attrs?.listStart)).toEqual([5, 5]);
		expect(lists.map((list) => list.attrs?.start)).toEqual([5, 6]);
	});

	it("keeps a reused root and nested identity in separate numbering scopes", () => {
		const root = ptListItem("root", "Root", "shared", 1);
		const nested = { ...ptListItem("nested", "Nested", "shared", 5), level: 2 };
		const rootTwo = ptListItem("root-two", "Root two", "shared", 1);
		const lists = allOrderedLists(portableTextToProsemirror([root, nested, rootTwo]));

		expect(lists).toHaveLength(2);
		expect(lists.map((list) => list.attrs?.listStart)).toEqual([1, 5]);
		expect(lists.map((list) => list.attrs?.start)).toEqual([1, 5]);
		expect(lists[1]?.attrs?.listId).not.toBe("shared");
	});

	it("bounds and canonicalizes untrusted metadata", () => {
		expect(normalizeListId("  list-a  ")).toBe("list-a");
		expect(normalizeListId(" ")).toBeUndefined();
		expect(normalizeListId("x".repeat(129))).toBeUndefined();
		expect(normalizeListStart(1)).toBe(1);
		expect(normalizeListStart(MAX_ORDERED_LIST_START)).toBe(MAX_ORDERED_LIST_START);
		expect(normalizeListStart(0)).toBeUndefined();
		expect(normalizeListStart(1.5)).toBeUndefined();
		expect(normalizeListStart(MAX_ORDERED_LIST_START + 1)).toBeUndefined();
	});
});
