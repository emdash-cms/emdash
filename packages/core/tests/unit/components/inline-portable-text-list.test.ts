import { describe, expect, it } from "vitest";

import {
	_pmToPortableText as pmToPortableText,
	_portableTextToPM as portableTextToPM,
} from "../../../src/components/InlinePortableTextEditor.js";

type PMNode = {
	type?: string;
	attrs?: Record<string, unknown>;
	content?: PMNode[];
};

function numbered(key: string, text: string, level: number, listStart: number) {
	return {
		_type: "block" as const,
		_key: key,
		style: "normal" as const,
		listItem: "number" as const,
		level,
		listId: "shared",
		listStart,
		children: [{ _type: "span" as const, _key: `${key}-span`, text }],
	};
}

function collectOrderedLists(node: PMNode): PMNode[] {
	const lists: PMNode[] = [];
	if (node.type === "orderedList") lists.push(node);
	for (const child of node.content ?? []) lists.push(...collectOrderedLists(child));
	return lists;
}

describe("inline Portable Text list conversion", () => {
	it("preserves nested list structure in both directions", () => {
		const pm = portableTextToPM([
			numbered("root", "Root", 1, 1),
			numbered("nested", "Nested", 2, 5),
			numbered("root-two", "Root two", 1, 1),
		]);
		const lists = collectOrderedLists(pm);

		expect(lists).toHaveLength(2);
		expect(lists.map((list) => list.attrs?.listStart)).toEqual([1, 5]);
		expect(lists.map((list) => list.attrs?.start)).toEqual([1, 5]);
		expect(lists[0]?.attrs?.listId).toBe("shared");
		expect(lists[1]?.attrs?.listId).not.toBe("shared");

		const portableText = pmToPortableText(pm) as Array<{
			listItem?: string;
			level?: number;
			children?: Array<{ text?: string }>;
		}>;
		expect(
			portableText.map((block) => [block.listItem, block.level, block.children?.[0]?.text]),
		).toEqual([
			["number", 1, "Root"],
			["number", 2, "Nested"],
			["number", 1, "Root two"],
		]);
	});

	it("does not drop nested ProseMirror lists when saving", () => {
		const portableText = pmToPortableText({
			type: "doc",
			content: [
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							content: [
								{ type: "paragraph", content: [{ type: "text", text: "Root" }] },
								{
									type: "orderedList",
									attrs: { listId: "nested", listStart: 3, start: 3 },
									content: [
										{
											type: "listItem",
											content: [
												{
													type: "paragraph",
													content: [{ type: "text", text: "Nested" }],
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
		}) as Array<{
			listItem?: string;
			level?: number;
			listId?: string;
			listStart?: number;
			children?: Array<{ text?: string }>;
		}>;

		expect(
			portableText.map((block) => [
				block.listItem,
				block.level,
				block.listId,
				block.listStart,
				block.children?.[0]?.text,
			]),
		).toEqual([
			["bullet", 1, undefined, undefined, "Root"],
			["number", 2, "nested", 3, "Nested"],
		]);
	});

	it("preserves continuity across supported top-level separators", () => {
		const blocks = [
			numbered("one", "One", 1, 1),
			{
				_type: "block" as const,
				_key: "plain",
				style: "normal" as const,
				children: [{ _type: "span" as const, _key: "plain-span", text: "Plain" }],
			},
			numbered("two", "Two", 1, 1),
			{
				_type: "block" as const,
				_key: "formatted",
				style: "normal" as const,
				children: [
					{
						_type: "span" as const,
						_key: "formatted-span",
						text: "Formatted",
						marks: ["strong"],
					},
				],
			},
			numbered("three", "Three", 1, 1),
			{ _type: "code", _key: "code", code: "x", language: "ts" },
			numbered("four", "Four", 1, 1),
			{
				_type: "image",
				_key: "image",
				asset: { _ref: "image", url: "/image.png" },
			},
			numbered("five", "Five", 1, 1),
			{ _type: "embed", _key: "plugin", id: "plugin", title: "Plugin" },
			numbered("six", "Six", 1, 1),
		];
		const pm = portableTextToPM(blocks);
		const rootNodes = pm.content as PMNode[];
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

		const roundTripped = pmToPortableText(pm) as Array<{
			listItem?: string;
			listId?: string;
			listStart?: number;
		}>;
		expect(
			roundTripped
				.filter((block) => block.listItem === "number")
				.map((block) => [block.listId, block.listStart]),
		).toEqual(Array.from({ length: 6 }, () => ["shared", 1]));
	});
});
