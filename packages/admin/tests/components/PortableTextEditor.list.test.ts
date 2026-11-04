import { describe, it, expect } from "vitest";

import {
	_portableTextToProsemirror,
	_prosemirrorToPortableText,
} from "../../src/components/PortableTextEditor";

type ListBlock = {
	_type: "block";
	style: "normal";
	listItem: "bullet" | "number";
	level: number;
	listId?: string;
	listStart?: number;
	children: Array<{ _type: "span"; text: string }>;
};

function isListBlock(b: unknown): b is ListBlock {
	return (
		typeof b === "object" &&
		b !== null &&
		(b as { _type?: unknown })._type === "block" &&
		"listItem" in (b as Record<string, unknown>)
	);
}

describe("ProseMirror → PortableText: nested list level", () => {
	it("emits level=1 for a single-level bullet list", () => {
		const pmDoc = {
			type: "doc",
			content: [
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							content: [{ type: "paragraph", content: [{ type: "text", text: "Item one" }] }],
						},
						{
							type: "listItem",
							content: [{ type: "paragraph", content: [{ type: "text", text: "Item two" }] }],
						},
					],
				},
			],
		};

		const result = _prosemirrorToPortableText(pmDoc).filter(isListBlock);

		expect(result.map((b) => [b.listItem, b.level, b.children[0]?.text])).toEqual([
			["bullet", 1, "Item one"],
			["bullet", 1, "Item two"],
		]);
	});

	it("emits level=2 for bullets nested inside a parent bullet", () => {
		const pmDoc = {
			type: "doc",
			content: [
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							content: [
								{ type: "paragraph", content: [{ type: "text", text: "Parent" }] },
								{
									type: "bulletList",
									content: [
										{
											type: "listItem",
											content: [
												{
													type: "paragraph",
													content: [{ type: "text", text: "Child" }],
												},
											],
										},
									],
								},
							],
						},
					],
				},
			],
		};

		const result = _prosemirrorToPortableText(pmDoc).filter(isListBlock);

		expect(result.map((b) => [b.listItem, b.level, b.children[0]?.text])).toEqual([
			["bullet", 1, "Parent"],
			["bullet", 2, "Child"],
		]);
	});

	it("preserves listItem type when an ordered list nests inside a bullet", () => {
		const pmDoc = {
			type: "doc",
			content: [
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							content: [
								{ type: "paragraph", content: [{ type: "text", text: "Bullet top" }] },
								{
									type: "orderedList",
									content: [
										{
											type: "listItem",
											content: [
												{
													type: "paragraph",
													content: [{ type: "text", text: "Numbered child" }],
												},
											],
										},
									],
								},
							],
						},
					],
				},
			],
		};

		const result = _prosemirrorToPortableText(pmDoc).filter(isListBlock);

		expect(result.map((b) => [b.listItem, b.level, b.children[0]?.text])).toEqual([
			["bullet", 1, "Bullet top"],
			["number", 2, "Numbered child"],
		]);
	});

	it("handles three-level nesting", () => {
		const pmDoc = {
			type: "doc",
			content: [
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							content: [
								{ type: "paragraph", content: [{ type: "text", text: "L1" }] },
								{
									type: "bulletList",
									content: [
										{
											type: "listItem",
											content: [
												{ type: "paragraph", content: [{ type: "text", text: "L2" }] },
												{
													type: "bulletList",
													content: [
														{
															type: "listItem",
															content: [
																{
																	type: "paragraph",
																	content: [{ type: "text", text: "L3" }],
																},
															],
														},
													],
												},
											],
										},
									],
								},
							],
						},
					],
				},
			],
		};

		const result = _prosemirrorToPortableText(pmDoc).filter(isListBlock);

		expect(result.map((b) => [b.level, b.children[0]?.text])).toEqual([
			[1, "L1"],
			[2, "L2"],
			[3, "L3"],
		]);
	});
});

type PMList = {
	type: "bulletList" | "orderedList";
	attrs?: Record<string, unknown>;
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

function pt(
	listItem: "bullet" | "number",
	level: number,
	text: string,
): {
	_type: "block";
	_key: string;
	style: "normal";
	listItem: "bullet" | "number";
	level: number;
	children: Array<{ _type: "span"; _key: string; text: string }>;
} {
	return {
		_type: "block",
		_key: `b${level}-${text}`,
		style: "normal",
		listItem,
		level,
		children: [{ _type: "span", _key: `s-${text}`, text }],
	};
}

describe("PortableText → ProseMirror: nested list level", () => {
	it("nests level=2 bullets inside their parent listItem", () => {
		const result = _portableTextToProsemirror([
			pt("bullet", 1, "Parent"),
			pt("bullet", 2, "Child"),
		]);
		const list = findFirstList(result);
		expect(list).toBeTruthy();
		expect(list!.type).toBe("bulletList");
		expect(list!.content).toHaveLength(1);
		expect(getParagraphText(list!.content[0]!)).toBe("Parent");

		const nested = getNestedList(list!.content[0]!);
		expect(nested?.type).toBe("bulletList");
		expect(nested?.content).toHaveLength(1);
		expect(getParagraphText(nested!.content[0]!)).toBe("Child");
	});

	it("preserves listType when an ordered list nests inside a bullet", () => {
		const result = _portableTextToProsemirror([
			pt("bullet", 1, "Bullet top"),
			pt("number", 2, "Numbered child"),
		]);
		const outer = findFirstList(result);
		expect(outer?.type).toBe("bulletList");
		expect(outer?.content).toHaveLength(1);

		const inner = getNestedList(outer!.content[0]!);
		expect(inner?.type).toBe("orderedList");
		expect(inner?.content).toHaveLength(1);
		expect(getParagraphText(inner!.content[0]!)).toBe("Numbered child");
	});

	it("does not flatten level=2 siblings into a top-level number list", () => {
		// Regression for the outer-loop run grouping: a number block at level=2
		// must be folded into its parent bullet's run, not start a new top-level
		// orderedList.
		const result = _portableTextToProsemirror([
			pt("bullet", 1, "Parent"),
			pt("number", 2, "Numbered child"),
			pt("bullet", 1, "Sibling"),
		]);
		const lists = (result.content as Array<{ type?: string }>).filter(
			(c) => c.type === "bulletList" || c.type === "orderedList",
		) as PMList[];
		expect(lists).toHaveLength(1);
		expect(lists[0]!.type).toBe("bulletList");
		expect(lists[0]!.content).toHaveLength(2);
		expect(getParagraphText(lists[0]!.content[0]!)).toBe("Parent");
		expect(getParagraphText(lists[0]!.content[1]!)).toBe("Sibling");
		expect(getNestedList(lists[0]!.content[0]!)?.type).toBe("orderedList");
	});

	it("handles three-level nesting", () => {
		const result = _portableTextToProsemirror([
			pt("bullet", 1, "L1"),
			pt("bullet", 2, "L2"),
			pt("bullet", 3, "L3"),
		]);
		const l1 = findFirstList(result);
		expect(getParagraphText(l1!.content[0]!)).toBe("L1");

		const l2 = getNestedList(l1!.content[0]!);
		expect(l2?.type).toBe("bulletList");
		expect(getParagraphText(l2!.content[0]!)).toBe("L2");

		const l3 = getNestedList(l2!.content[0]!);
		expect(l3?.type).toBe("bulletList");
		expect(getParagraphText(l3!.content[0]!)).toBe("L3");
	});

	it("keeps deeper nesting under its true parent for mixed-type 3-level trees", () => {
		// Regression for convertPTListItem's nested grouping: it used to
		// break the group on every `listItem` change regardless of depth,
		// so a level-3 block ended up as a sibling sub-list under the
		// level-1 item instead of nesting under the matching level-2 item
		// — and the round-trip would degrade level-3 to level-2.
		const original = [
			pt("bullet", 1, "A"),
			pt("number", 2, "B"),
			pt("bullet", 3, "C"),
			pt("number", 2, "D"),
		];
		const pm = _portableTextToProsemirror(original);

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
		const roundTripped = _prosemirrorToPortableText(pm).filter(
			(b): b is (typeof original)[number] =>
				typeof b === "object" && b !== null && (b as { _type?: string })._type === "block",
		);
		expect(roundTripped.map((b) => [b.listItem, b.level, b.children[0]?.text])).toEqual([
			["bullet", 1, "A"],
			["number", 2, "B"],
			["bullet", 3, "C"],
			["number", 2, "D"],
		]);
	});
});

describe("Round-trip: PT → PM → PT preserves nested list level", () => {
	it("keeps level and listItem for a 2-level bullet → number tree", () => {
		const original = [
			pt("bullet", 1, "Top"),
			pt("number", 2, "Nested"),
			pt("bullet", 1, "Sibling"),
		];
		const pm = _portableTextToProsemirror(original);
		const roundTripped = _prosemirrorToPortableText(pm).filter(
			(b): b is (typeof original)[number] =>
				typeof b === "object" && b !== null && (b as { _type?: string })._type === "block",
		);
		expect(roundTripped.map((b) => [b.listItem, b.level, b.children[0]?.text])).toEqual([
			["bullet", 1, "Top"],
			["number", 2, "Nested"],
			["bullet", 1, "Sibling"],
		]);
	});
});

describe("numbered-list continuity metadata", () => {
	it("preserves an explicit ordered-list start", () => {
		const portableText = _prosemirrorToPortableText({
			type: "doc",
			content: [
				{
					type: "orderedList",
					attrs: { start: 2 },
					content: [
						{
							type: "listItem",
							content: [{ type: "paragraph", content: [{ type: "text", text: "Second" }] }],
						},
					],
				},
			],
		}).filter(isListBlock);

		expect(portableText[0]).toMatchObject({ listStart: 2 });
		expect(portableText[0]?.listId).toBeTruthy();

		const list = findFirstList(_portableTextToProsemirror(portableText));
		expect(list?.attrs).toMatchObject({
			start: 2,
			listStart: 2,
			listId: portableText[0]?.listId,
		});
	});

	it.each([
		{ listId: "  valid  ", listStart: 2, expectedId: "valid", expectedStart: 2 },
		{ listId: " ", listStart: 0, expectedStart: 1 },
		{ listId: "x".repeat(129), listStart: 2_147_483_648, expectedStart: 1 },
		{
			listId: "maximum",
			listStart: 2_147_483_647,
			expectedId: "maximum",
			expectedStart: 2_147_483_647,
		},
	])("normalizes numbered-list metadata %#", ({ listId, listStart, expectedId, expectedStart }) => {
		const list = findFirstList(
			_portableTextToProsemirror([
				{
					...pt("number", 1, "Item"),
					listId,
					listStart,
				},
			]),
		);

		expect(list?.attrs?.start).toBe(expectedStart);
		expect(list?.attrs?.listStart).toBe(expectedStart);
		if (expectedId) {
			expect(list?.attrs?.listId).toBe(expectedId);
		} else {
			expect(typeof list?.attrs?.listId).toBe("string");
			expect(list?.attrs?.listId).not.toBe(listId);
		}
	});

	it("derives a continuation start across an intervening block", () => {
		const numbered = (key: string, text: string) => ({
			...pt("number" as const, 1, text),
			_key: key,
			listId: "shared-list",
			listStart: 1,
		});
		const doc = _portableTextToProsemirror([
			numbered("one", "One"),
			numbered("two", "Two"),
			{
				_type: "block",
				_key: "between",
				style: "normal",
				children: [{ _type: "span", _key: "between-span", text: "Between" }],
			},
			numbered("three", "Three"),
		]);
		const lists = (doc.content as Array<{ type?: string }>).filter(
			(node) => node.type === "orderedList",
		) as PMList[];

		expect(lists.map((list) => list.attrs?.start)).toEqual([1, 3]);
		expect(lists.map((list) => list.attrs?.listId)).toEqual(["shared-list", "shared-list"]);
	});

	it("uses a later valid base when an earlier segment has no base", () => {
		const first = { ...pt("number", 1, "Five"), listId: "shared-list" };
		const second = {
			...pt("number", 1, "Six"),
			listId: "shared-list",
			listStart: 5,
		};
		const doc = _portableTextToProsemirror([
			first,
			{
				_type: "block",
				_key: "between",
				style: "normal",
				children: [{ _type: "span", _key: "between-span", text: "Between" }],
			},
			second,
		]);
		const lists = (doc.content as Array<{ type?: string }>).filter(
			(node) => node.type === "orderedList",
		) as PMList[];

		expect(lists.map((list) => list.attrs?.listStart)).toEqual([5, 5]);
		expect(lists.map((list) => list.attrs?.start)).toEqual([5, 6]);
	});

	it("keeps a reused root and nested identity in separate numbering scopes", () => {
		const withMetadata = (key: string, text: string, level: number, listStart: number) => ({
			...pt("number", level, text),
			_key: key,
			listId: "shared-list",
			listStart,
		});
		const doc = _portableTextToProsemirror([
			withMetadata("root", "Root", 1, 1),
			withMetadata("nested", "Nested", 2, 5),
			withMetadata("root-two", "Root two", 1, 1),
		]);
		const outer = findFirstList(doc);
		const nested = getNestedList(outer!.content[0]!);

		expect(outer?.attrs).toMatchObject({ listId: "shared-list", listStart: 1, start: 1 });
		expect(nested?.attrs).toMatchObject({ listStart: 5, start: 5 });
		expect(nested?.attrs?.listId).not.toBe("shared-list");
	});

	it("survives save and reload across every supported top-level separator", () => {
		const numberedList = (label: string, start: number) => ({
			type: "orderedList",
			attrs: { start, listStart: 1, listId: "shared-list" },
			content: [
				{
					type: "listItem",
					content: [{ type: "paragraph", content: [{ type: "text", text: label }] }],
				},
			],
		});
		const portableText = _prosemirrorToPortableText({
			type: "doc",
			content: [
				numberedList("One", 1),
				{ type: "paragraph", content: [{ type: "text", text: "Plain" }] },
				numberedList("Two", 2),
				{
					type: "paragraph",
					content: [{ type: "text", text: "Formatted", marks: [{ type: "bold" }] }],
				},
				numberedList("Three", 3),
				{ type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "x" }] },
				numberedList("Four", 4),
				{ type: "image", attrs: { src: "/image.png", mediaId: "image" } },
				numberedList("Five", 5),
				{
					type: "pluginBlock",
					attrs: { blockType: "embed", id: "plugin", data: { title: "Plugin" } },
				},
				numberedList("Six", 6),
			],
		});
		const numberedBlocks = portableText.filter(
			(block): block is ListBlock => isListBlock(block) && block.listItem === "number",
		);
		expect(numberedBlocks.map((block) => [block.listId, block.listStart])).toEqual(
			Array.from({ length: 6 }, () => ["shared-list", 1]),
		);

		const reloaded = _portableTextToProsemirror(portableText);
		const rootNodes = reloaded.content as Array<{ type?: string; attrs?: Record<string, unknown> }>;
		const lists = rootNodes.filter((node) => node.type === "orderedList");
		expect(lists.map((list) => list.attrs?.start)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(rootNodes.map((node) => node.type)).toEqual([
			"orderedList",
			"paragraph",
			"orderedList",
			"paragraph",
			"orderedList",
			"codeBlock",
			"orderedList",
			"image",
			"orderedList",
			"pluginBlock",
			"orderedList",
		]);
	});
});
