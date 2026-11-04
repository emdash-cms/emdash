import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import PortableText from "../../src/components/PortableText.astro";
import CustomOrderedList from "./fixtures/CustomOrderedList.astro";

function item(key: string, text: string, level: number, listId: string, listStart: number) {
	return {
		_type: "block",
		_key: key,
		style: "normal",
		listItem: "number",
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
	markDefs: [{ _key: "link", _type: "link", href: "https://example.com" }],
	children: [{ _type: "span", _key: "between-span", text: "Between", marks: ["link"] }],
};

async function render(value: unknown[], props: Record<string, unknown> = {}) {
	const container = await AstroContainer.create();
	return container.renderToString(PortableText, { props: { value, ...props } });
}

function orderedListTags(html: string): string[] {
	return html.match(/<ol\b[^>]*>/g) ?? [];
}

describe("PortableText numbered-list rendering", () => {
	it("renders continuation segments with semantic starts without mutating input", async () => {
		const value = [
			item("one", "One", 1, "shared", 1),
			item("two", "Two", 1, "shared", 1),
			paragraph,
			item("three", "Three", 1, "shared", 1),
			item("four", "Four", 1, "shared", 1),
		];
		const before = structuredClone(value);
		const html = await render(value);
		const lists = orderedListTags(html);

		expect(lists).toHaveLength(2);
		expect(lists[0]).not.toContain("start=");
		expect(lists[1]).toContain('start="3"');
		expect(value).toEqual(before);
	});

	it.each(["html", "direct"] as const)(
		"keeps independent root and nested identities separate in %s mode",
		async (listNestingMode) => {
			const value = [
				item("root", "Root", 1, "root", 1),
				item("nested-a", "Nested A", 2, "nested-a", 2),
				item("nested-b", "Nested B", 2, "nested-b", 7),
				item("root-two", "Root two", 1, "root", 1),
				item("other", "Other", 1, "other", 4),
			];
			const html = await render(value, { listNestingMode });
			const lists = orderedListTags(html);

			expect(lists).toHaveLength(4);
			expect(lists.filter((tag) => tag.includes('start="2"'))).toHaveLength(1);
			expect(lists.filter((tag) => tag.includes('start="7"'))).toHaveLength(1);
			expect(lists.filter((tag) => tag.includes('start="4"'))).toHaveLength(1);
		},
	);

	it("keeps a user numbered-list component override", async () => {
		const html = await render([item("three", "Three", 1, "shared", 3)], {
			components: { list: { number: CustomOrderedList } },
		});

		expect(html).toContain('data-custom-list="true"');
		expect(html).toContain('data-start="3"');
	});
});
