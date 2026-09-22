import { describe, expect, it } from "vitest";

import {
	buildPortableTextListTree,
	clonePortableTextValue,
} from "../../../src/content/portable-text-lists.js";

function item(
	key: string,
	text: string,
	listItem: "bullet" | "number",
	level: number,
	listId?: string,
	listStart?: number,
) {
	return {
		_type: "block",
		_key: key,
		style: "normal",
		listItem,
		level,
		listId,
		listStart,
		markDefs: [],
		children: [{ _type: "span", _key: `${key}-span`, text, marks: [] }],
	};
}

const paragraph = {
	_type: "block",
	_key: "between",
	style: "normal",
	markDefs: [],
	children: [{ _type: "span", _key: "between-span", text: "Between", marks: [] }],
};

function collectLists(value: unknown): Array<Record<string, unknown>> {
	const lists: Array<Record<string, unknown>> = [];
	const visit = (node: unknown) => {
		if (!node || typeof node !== "object") return;
		const record = node as Record<string, unknown>;
		if (record._type === "@list") lists.push(record);
		if (Array.isArray(record.children)) record.children.forEach(visit);
	};
	if (Array.isArray(value)) value.forEach(visit);
	else visit(value);
	return lists;
}

describe("buildPortableTextListTree", () => {
	it.each(["html", "direct"] as const)(
		"continues a numbered identity across a non-list block in %s mode",
		(mode) => {
			const value = [
				item("one", "One", "number", 1, "shared", 1),
				item("two", "Two", "number", 1, "shared", 1),
				paragraph,
				item("three", "Three", "number", 1, "shared", 1),
			];
			const before = structuredClone(value);
			const tree = buildPortableTextListTree(value, mode);
			const lists = collectLists(tree);

			expect(lists.map((list) => list.start)).toEqual([1, 3]);
			expect(value).toEqual(before);
		},
	);

	it.each(["html", "direct"] as const)(
		"keeps adjacent independent identities separate at root and nested levels in %s mode",
		(mode) => {
			const value = [
				item("root", "Root", "number", 1, "root", 1),
				item("nested-a", "Nested A", "number", 2, "nested-a", 2),
				item("nested-b", "Nested B", "number", 2, "nested-b", 7),
				item("root-two", "Root two", "number", 1, "root", 1),
				item("other", "Other", "number", 1, "other", 4),
			];
			const lists = collectLists(buildPortableTextListTree(value, mode));

			expect(lists.map((list) => list.start)).toEqual([1, 2, 7, 4]);
		},
	);

	it("uses separate counters when a malformed identity is reused across contexts", () => {
		const value = [
			item("root", "Root", "number", 1, "shared", 1),
			item("nested", "Nested", "number", 2, "shared", 5),
			item("root-two", "Root two", "number", 1, "shared", 1),
		];
		const lists = collectLists(buildPortableTextListTree(value, "direct"));

		expect(lists.map((list) => list.start)).toEqual([1, 5]);
	});

	it("uses the first valid base and falls back to one on overflow", () => {
		const value = [
			item("one", "One", "number", 1, "shared", undefined),
			item("two", "Two", "number", 1, "shared", 2),
			paragraph,
			item("three", "Three", "number", 1, "shared", 99),
			item("max", "Max", "number", 1, "max", 2_147_483_647),
			paragraph,
			item("overflow", "Overflow", "number", 1, "max", 2_147_483_647),
		];
		const lists = collectLists(buildPortableTextListTree(value, "direct"));

		expect(lists.map((list) => list.start)).toEqual([2, 4, 2_147_483_647, 1]);
	});

	it("uses a later segment's base when the first segment has no listStart", () => {
		const value = [
			item("one", "One", "number", 1, "shared", undefined),
			paragraph,
			item("two", "Two", "number", 1, "shared", 5),
		];
		const lists = collectLists(buildPortableTextListTree(value, "direct"));

		expect(lists.map((list) => list.start)).toEqual([5, 6]);
	});

	it("handles sparse untrusted nesting levels in bounded work", () => {
		const value = [
			item("root", "Root", "number", 1, "root", 1),
			item("deep", "Deep", "number", Number.MAX_SAFE_INTEGER, "deep", 1),
		];
		const lists = collectLists(buildPortableTextListTree(value, "direct"));

		expect(lists.map((list) => [list.level, list.start])).toEqual([
			[1, 1],
			[Number.MAX_SAFE_INTEGER, 1],
		]);
	});
});

describe("numbered list preprocessing", () => {
	it("deep-clones nested Portable Text data", () => {
		const value = [
			{
				...paragraph,
				markDefs: [{ _key: "link", _type: "link", href: "https://example.com" }],
			},
		];
		const clone = clonePortableTextValue(value);
		(clone[0].children[0] as { text: string }).text = "Changed";
		(clone[0].markDefs[0] as { href: string }).href = "https://changed.example";

		expect(value[0].children[0].text).toBe("Between");
		expect(value[0].markDefs[0].href).toBe("https://example.com");
	});
});
