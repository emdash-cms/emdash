import { describe, expect, it } from "vitest";

import { coreTransformers, gutenbergToPortableText, parseInlineContent } from "../src/index.js";

const block = (figure: string) =>
	`<!-- wp:table --><figure class="wp-block-table">${figure}</figure><!-- /wp:table -->`;
const tbl = (rows: string) => block(`<table>${rows}</table>`);

function convert(html: string) {
	let key = 0;
	return gutenbergToPortableText(html, { keyGenerator: () => `k${++key}` });
}

describe("core/table converts loosely structured cell markup", () => {
	it("keeps a table whose cell contains a stray closing tag", () => {
		expect(convert(tbl("<tr><td>a</span>b</td><td>c</td></tr>"))).toEqual([
			{
				_type: "table",
				_key: "k6",
				rows: [
					{
						_type: "tableRow",
						_key: "k5",
						cells: [
							{
								_type: "tableCell",
								_key: "k2",
								content: [{ _type: "span", _key: "k1", text: "ab" }],
							},
							{
								_type: "tableCell",
								_key: "k4",
								content: [{ _type: "span", _key: "k3", text: "c" }],
							},
						],
					},
				],
				hasHeaderRow: false,
			},
		]);
	});

	it("keeps a table whose cell has paragraphs without </p>", () => {
		expect(convert(tbl("<tr><td><p>One<p>Two</td><td>c</td></tr>"))).toEqual([
			{
				_type: "table",
				_key: "k7",
				rows: [
					{
						_type: "tableRow",
						_key: "k6",
						cells: [
							{
								_type: "tableCell",
								_key: "k3",
								content: [
									{ _type: "span", _key: "k1", text: "One" },
									{ _type: "span", _key: "k2", text: "Two" },
								],
							},
							{
								_type: "tableCell",
								_key: "k5",
								content: [{ _type: "span", _key: "k4", text: "c" }],
							},
						],
					},
				],
				hasHeaderRow: false,
			},
		]);
	});

	it("keeps a table whose cell has list items without </li>", () => {
		expect(convert(tbl("<tr><td><ul><li>a<li>b</ul></td><td>c</td></tr>"))).toEqual([
			{
				_type: "table",
				_key: "k7",
				rows: [
					{
						_type: "tableRow",
						_key: "k6",
						cells: [
							{
								_type: "tableCell",
								_key: "k3",
								content: [
									{ _type: "span", _key: "k1", text: "a" },
									{ _type: "span", _key: "k2", text: "b" },
								],
							},
							{
								_type: "tableCell",
								_key: "k5",
								content: [{ _type: "span", _key: "k4", text: "c" }],
							},
						],
					},
				],
				hasHeaderRow: false,
			},
		]);
	});

	it("ends a row without </tr> at the next </tr>", () => {
		expect(
			convert(tbl("<tbody><tr><td>a</td><tr><td>b</td></tr><tr><td>c</td></tr></tbody>")),
		).toEqual([
			{
				_type: "table",
				_key: "k9",
				rows: [
					{
						_type: "tableRow",
						_key: "k5",
						cells: [
							{
								_type: "tableCell",
								_key: "k2",
								content: [{ _type: "span", _key: "k1", text: "a" }],
							},
							{
								_type: "tableCell",
								_key: "k4",
								content: [{ _type: "span", _key: "k3", text: "b" }],
							},
						],
					},
					{
						_type: "tableRow",
						_key: "k8",
						cells: [
							{
								_type: "tableCell",
								_key: "k7",
								content: [{ _type: "span", _key: "k6", text: "c" }],
							},
						],
					},
				],
				hasHeaderRow: false,
			},
		]);
	});

	it("keeps outer-cell text around a nested table", () => {
		expect(
			convert(
				tbl("<tr><td><strong>Outer</strong><table><tr><td>Inner</td></tr></table></td></tr>"),
			),
		).toEqual([
			{
				_type: "table",
				_key: "k5",
				rows: [
					{
						_type: "tableRow",
						_key: "k4",
						cells: [
							{
								_type: "tableCell",
								_key: "k3",
								content: [
									{ _type: "span", _key: "k1", text: "Outer", marks: ["strong"] },
									{ _type: "span", _key: "k2", text: "Inner" },
								],
							},
						],
					},
				],
				hasHeaderRow: false,
			},
		]);
	});

	it.each([
		{
			label: "cell text after an HTML comment",
			rows: "<tr><td><!-- note -->Visible</td></tr>",
			text: "Visible",
		},
		{
			label: "a cell containing a <tr> without </tr>",
			rows: "<tr><td><tr>ab</td></tr>",
			text: "ab",
		},
		{
			label: "a <td> cell after a <th> without </th>",
			rows: "<tr><th>a<td>b</td></tr>",
			text: "b",
		},
		{ label: "rows after an empty <tbody>", rows: "<tbody></tbody><tr><td>a</td></tr>", text: "a" },
	])("keeps $label", ({ rows, text }) => {
		expect(convert(tbl(rows))).toEqual([
			{
				_type: "table",
				_key: "k4",
				rows: [
					{
						_type: "tableRow",
						_key: "k3",
						cells: [
							{ _type: "tableCell", _key: "k2", content: [{ _type: "span", _key: "k1", text }] },
						],
					},
				],
				hasHeaderRow: false,
			},
		]);
	});
});

describe("core/table parses unclosed tags in linear time", () => {
	it.each([
		{
			label: "unclosed tr",
			makeHtml: () => tbl("<tr><td>x</td>".repeat(20_000)),
		},
		{
			label: "unclosed td",
			makeHtml: () => tbl("<tr>" + "<td>x".repeat(20_000) + "</tr>"),
		},
		{
			label: "repeated thead",
			makeHtml: () => tbl("<thead>".repeat(20_000)),
		},
		{
			label: "repeated tbody",
			makeHtml: () => tbl("<tbody>".repeat(20_000)),
		},
		{
			label: "closing tags before rows",
			makeHtml: () => tbl("</tr>".repeat(20_000) + "<tr>".repeat(20_000)),
		},
		{
			label: "repeated th closes in td rows",
			makeHtml: () => tbl("<tr>" + "<td>x</th>".repeat(20_000) + "</tr>"),
		},
		{
			label: "repeated table open",
			makeHtml: () => block("<table>".repeat(20_000)),
		},
		{
			label: "unterminated tag names",
			makeHtml: () => tbl("<tr><td".repeat(20_000)),
		},
	])("handles $label without quadratic time", ({ makeHtml }) => {
		const html = makeHtml();
		const start = process.cpuUsage();
		gutenbergToPortableText(html);
		const { user, system } = process.cpuUsage(start);
		expect((user + system) / 1000).toBeLessThan(1000);
	});

	it("handles unterminated comments without quadratic time", () => {
		let key = 0;
		const generateKey = () => String(++key);
		const innerHTML = "<table>" + "<!--".repeat(20_000) + "</table>";
		const start = process.cpuUsage();
		coreTransformers.table(
			{ blockName: "core/table", attrs: {}, innerHTML, innerBlocks: [], innerContent: [] },
			{},
			{
				generateKey,
				parseInlineContent: (html) => parseInlineContent(html, generateKey),
				transformBlocks: () => [],
			},
		);
		const { user, system } = process.cpuUsage(start);
		expect((user + system) / 1000).toBeLessThan(1000);
	});

	it("still converts a well-formed large table quickly", () => {
		const html = tbl("<tr><td>x</td></tr>".repeat(20_000));
		const start = process.cpuUsage();
		const result = gutenbergToPortableText(html);
		const { user, system } = process.cpuUsage(start);
		expect(result).toHaveLength(1);
		expect((result[0] as { rows: unknown[] }).rows).toHaveLength(20_000);
		expect((user + system) / 1000).toBeLessThan(500);
	});

	it("handles deeply nested <td> tags in linear time", () => {
		const n = 4_000;
		const html = tbl("<tr>" + "<td>".repeat(n) + "x" + "</td>".repeat(n) + "</tr>");
		const start = process.cpuUsage();
		const result = gutenbergToPortableText(html);
		const { user, system } = process.cpuUsage(start);
		expect(result).toHaveLength(1);
		expect((user + system) / 1000).toBeLessThan(1000);
	});
});
