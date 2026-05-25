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
