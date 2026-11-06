import { MAX_TABLE_REPAIRED_SLOTS } from "@emdash-cms/admin/portable-text-table";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import PortableText from "../../src/components/PortableText.astro";

async function render(value: unknown[], tablePlaceholder?: string) {
	const container = await AstroContainer.create();
	container.addServerRenderer({
		name: "@astrojs/react",
		renderer: {
			check: async () => false,
			renderToStaticMarkup: async () => {
				throw new Error("Expected a client-only editor");
			},
		},
	});
	container.addClientRenderer({ name: "@astrojs/react", entrypoint: "@astrojs/react/client.js" });
	return container.renderToString(PortableText, { props: { value, tablePlaceholder } });
}

function tags(html: string, name: string): string[] {
	return html.match(new RegExp(`<${name}\\b[^>]*>`, "g")) ?? [];
}

describe("Portable Text table rendering", () => {
	it("forwards the localized table label to the inline editor island", async () => {
		const value: unknown[] = [];
		Object.defineProperty(value, Symbol.for("__emdash"), {
			value: { collection: "posts", id: "localized", field: "body" },
		});
		const label = "جدول (التحرير في لوحة الإدارة)";
		expect(await render(value, label)).toContain(label);
	});

	it("renders canonical headers, spans, widths, alignment, and inline marks", async () => {
		const html = await render([
			{
				_type: "table",
				_key: "table-canonical",
				hasHeaderRow: true,
				rows: [
					{
						_type: "tableRow",
						_key: "row-header",
						cells: [
							{
								_type: "tableCell",
								_key: "header-name",
								isHeader: true,
								colwidth: [140],
								content: [{ _type: "span", _key: "header-name-span", text: "Name" }],
							},
							{
								_type: "tableCell",
								_key: "header-details",
								isHeader: true,
								colspan: 2,
								colwidth: [160, 180],
								textAlign: "center",
								content: [{ _type: "span", _key: "header-details-span", text: "Details" }],
							},
						],
					},
					{
						_type: "tableRow",
						_key: "row-body",
						cells: [
							{
								_type: "tableCell",
								_key: "row-label",
								isHeader: true,
								colwidth: [140],
								content: [{ _type: "span", _key: "row-label-span", text: "EmDash" }],
							},
							{
								_type: "tableCell",
								_key: "strong-cell",
								colwidth: [160],
								textAlign: "right",
								content: [
									{ _type: "span", _key: "strong-span", text: "Portable", marks: ["strong"] },
								],
							},
							{
								_type: "tableCell",
								_key: "link-cell",
								colwidth: [180],
								content: [{ _type: "span", _key: "link-span", text: "Docs", marks: ["docs-link"] }],
								markDefs: [{ _type: "link", _key: "docs-link", href: "/docs" }],
							},
						],
					},
				],
			},
		]);

		const tableTags = tags(html, "table");
		const headerTags = tags(html, "th");
		const colTags = tags(html, "col");

		expect(tags(html, "thead")).toHaveLength(1);
		expect(tableTags.some((tag) => /min-width:\s*480px/.test(tag))).toBe(true);
		expect(headerTags.filter((tag) => tag.includes('scope="col"'))).toHaveLength(2);
		expect(headerTags.some((tag) => tag.includes('scope="row"'))).toBe(true);
		expect(headerTags.some((tag) => tag.includes('colspan="2"'))).toBe(true);
		expect(headerTags.some((tag) => /text-align:\s*center/.test(tag))).toBe(true);
		expect(tags(html, "td").some((tag) => /text-align:\s*right/.test(tag))).toBe(true);
		expect(colTags.some((tag) => /width:\s*140px/.test(tag))).toBe(true);
		expect(colTags.some((tag) => /width:\s*180px/.test(tag))).toBe(true);
		expect(html).toContain("<strong>Portable</strong>");
		expect(html).toMatch(/<a\b[^>]*href="\/docs"[^>]*>Docs<\/a>/);
	});

	it("renders valid sub-minimum preferences at the responsive visual minimum", async () => {
		const html = await render([
			{
				_type: "table",
				_key: "narrow-table",
				rows: [
					{
						_type: "tableRow",
						_key: "narrow-row",
						cells: Array.from({ length: 10 }, (_, index) => ({
							_type: "tableCell",
							_key: `narrow-${index}`,
							colwidth: [1],
							content: [{ _type: "span", _key: `span-${index}`, text: String(index) }],
						})),
					},
				],
			},
		]);

		expect(tags(html, "table").some((tag) => /min-width:\s*960px/.test(tag))).toBe(true);
		expect(tags(html, "col")).toHaveLength(10);
		expect(tags(html, "col").every((tag) => /width:\s*96px/.test(tag))).toBe(true);
	});

	it("renders legacy string cells as escaped text with legacy header-row semantics", async () => {
		const html = await render([
			{
				_type: "table",
				_key: "table-legacy",
				hasHeaderRow: true,
				rows: [
					{
						_type: "tableRow",
						_key: "legacy-header",
						cells: ["<script>alert('header')</script>", " Count "],
					},
					{
						_type: "tableRow",
						_key: "legacy-body",
						cells: ["EmDash", "2"],
					},
				],
			},
		]);

		expect(tags(html, "thead")).toHaveLength(1);
		expect(tags(html, "th").filter((tag) => tag.includes('scope="col"'))).toHaveLength(2);
		expect(html).toContain("&lt;script&gt;alert(&#39;header&#39;)&lt;/script&gt;");
		expect(html).not.toContain("<script>alert('header')</script>");
		expect(html).toContain(" Count ");
		expect(html).toContain("EmDash");
	});

	it("does not assign row scope to a header that spans multiple rows", async () => {
		const html = await render([
			{
				_type: "table",
				_key: "table-rowspan-header",
				rows: [
					{
						_type: "tableRow",
						_key: "row-one",
						cells: [
							{
								_type: "tableCell",
								_key: "spanning-header",
								isHeader: true,
								rowspan: 2,
								content: [{ _type: "span", _key: "spanning-header-span", text: "Group" }],
							},
							{
								_type: "tableCell",
								_key: "value-one",
								content: [{ _type: "span", _key: "value-one-span", text: "One" }],
							},
						],
					},
					{
						_type: "tableRow",
						_key: "row-two",
						cells: [
							{
								_type: "tableCell",
								_key: "value-two",
								content: [{ _type: "span", _key: "value-two-span", text: "Two" }],
							},
						],
					},
				],
			},
		]);

		const [header] = tags(html, "th");
		expect(header).toContain('rowspan="2"');
		expect(header).not.toContain('scope="row"');
	});

	it.each([false, true])(
		"renders every recoverable source cell with an empty leading row: %s",
		async (leadingEmptyRow) => {
			const cells = Array.from(
				{ length: MAX_TABLE_REPAIRED_SLOTS + (leadingEmptyRow ? 0 : 1) },
				(_, index) => ({
					_type: "tableCell",
					_key: `oversized-cell-${index}`,
					content: [
						index === 0
							? {
									_type: "block",
									children: [
										{
											_type: "span",
											_key: "oversized-span-0",
											text: "Cell 0",
										},
									],
								}
							: {
									_type: "span",
									_key: `oversized-span-${index}`,
									text: `Cell ${index}`,
								},
					],
				}),
			);
			const html = await render([
				{
					_type: "table",
					_key: "oversized-table",
					rows: [
						...(leadingEmptyRow ? [{ _type: "tableRow", _key: "empty-row", cells: [] }] : []),
						{ _type: "tableRow", _key: "oversized-row", cells },
					],
				},
			]);

			expect(tags(html, "td")).toHaveLength(cells.length);
			expect(html).toContain("Cell 0");
			expect(html).toContain("Cell 200");
			expect(html.match(/Cell \d+/g)?.at(-1)).toBe(`Cell ${cells.length - 1}`);
			expect(html).not.toContain("colspan");
		},
	);

	it("keeps nested text visible and escaped when unsupported cell content uses the fallback", async () => {
		const html = await render([
			{
				_type: "table",
				_key: "fallback-table",
				rows: [
					{
						_type: "tableRow",
						_key: "fallback-row",
						cells: [
							{
								_type: "tableCell",
								_key: "fallback-cell",
								content: [
									{
										_type: "block",
										children: [
											{
												_type: "span",
												_key: "nested-span",
												text: "<strong>Visible</strong>",
											},
										],
									},
								],
							},
						],
					},
				],
			},
		]);

		expect(html).toContain("&lt;strong&gt;Visible&lt;/strong&gt;");
		expect(html).not.toContain("<strong>Visible</strong>");
	});
});
