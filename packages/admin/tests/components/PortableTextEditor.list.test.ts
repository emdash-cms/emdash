import { describe, it, expect } from "vitest";

import { _prosemirrorToPortableText } from "../../src/components/PortableTextEditor";

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
