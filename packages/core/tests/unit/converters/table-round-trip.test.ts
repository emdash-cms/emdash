import { describe, expect, it } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type {
	PortableTextBlock,
	PortableTextTableBlock,
	ProseMirrorDocument,
} from "../../../src/content/converters/types.js";

const canonicalTable = {
	_type: "table",
	_key: "table-1",
	hasHeaderRow: true,
	markDefs: [{ _type: "link", _key: "link-1", href: "https://example.com" }],
	rows: [
		{
			_type: "tableRow",
			_key: "row-1",
			cells: [
				{
					_type: "tableCell",
					_key: "cell-1",
					content: [
						{
							_type: "span",
							_key: "span-1",
							text: "Linked heading",
							marks: ["strong", "link-1"],
						},
					],
					isHeader: true,
					colspan: 2,
					rowspan: 1,
					colwidth: [180, 220],
					textAlign: "right",
				},
			],
		},
	],
} satisfies PortableTextTableBlock;

describe("Portable Text table conversion", () => {
	it("keeps different targets for links sharing the same URL", () => {
		const source: PortableTextTableBlock = structuredClone(canonicalTable);
		source.markDefs!.push({ ...source.markDefs![0]!, _key: "new-tab", blank: true });
		source.rows[0]!.cells[0]!.content.push({
			_type: "span",
			_key: "new-tab-span",
			text: "New tab",
			marks: ["new-tab"],
		});
		const [result] = prosemirrorToPortableText(portableTextToProsemirror([source]));
		const cell = (result as PortableTextTableBlock).rows[0]!.cells[0]!;
		expect(
			cell.content.map(
				(span) => cell.markDefs?.find((mark) => span.marks?.includes(mark._key))?.blank,
			),
		).toEqual([false, true]);
	});

	it("converts a canonical table to a real ProseMirror table without losing identity", () => {
		const result = portableTextToProsemirror([canonicalTable]);

		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({
			type: "table",
			attrs: { emdashKey: "table-1" },
			content: [
				{
					type: "tableRow",
					attrs: { emdashKey: "row-1" },
					content: [
						{
							type: "tableHeader",
							attrs: {
								emdashKey: "cell-1",
								colspan: 2,
								rowspan: 1,
								colwidth: [180, 220],
								textAlign: "right",
							},
							content: [
								{
									type: "paragraph",
									content: [
										{
											type: "text",
											text: "Linked heading",
											marks: [
												{ type: "bold" },
												{
													type: "link",
													attrs: {
														href: "https://example.com",
														target: null,
													},
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
		});
		expect(JSON.stringify(result)).not.toContain("Unknown block type: table");
	});

	it("converts a ProseMirror table to canonical Portable Text without losing attributes", () => {
		const document: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "table",
					attrs: { emdashKey: "table-1" },
					content: [
						{
							type: "tableRow",
							attrs: { emdashKey: "row-1" },
							content: [
								{
									type: "tableHeader",
									attrs: {
										emdashKey: "cell-1",
										colspan: 2,
										rowspan: 1,
										colwidth: [180, 220],
										textAlign: "right",
									},
									content: [
										{
											type: "paragraph",
											content: [
												{
													type: "text",
													text: "Linked heading",
													marks: [
														{ type: "bold" },
														{
															type: "link",
															attrs: { href: "https://example.com" },
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

		const result = prosemirrorToPortableText(document);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			_type: "table",
			_key: "table-1",
			hasHeaderRow: true,
			rows: [
				{
					_type: "tableRow",
					_key: "row-1",
					cells: [
						{
							_type: "tableCell",
							_key: "cell-1",
							isHeader: true,
							colspan: 2,
							colwidth: [180, 220],
							textAlign: "right",
							content: [
								{
									_type: "span",
									text: "Linked heading",
									marks: ["strong", expect.any(String)],
								},
							],
						},
					],
				},
			],
		});
		const cell = (result[0] as { rows: Array<{ cells: Array<Record<string, unknown>> }> }).rows[0]!
			.cells[0]!;
		const linkKey = (cell.content as Array<{ marks?: string[] }>)[0]!.marks?.[1];
		expect(cell.markDefs).toContainEqual(
			expect.objectContaining({ _type: "link", _key: linkKey, href: "https://example.com" }),
		);
	});

	it("accepts legacy string cells and emits canonical cell content", () => {
		const legacy = {
			_type: "table",
			_key: "legacy-table",
			rows: [{ _type: "tableRow", _key: "legacy-row", cells: ["Name", "Value"] }],
		} satisfies PortableTextBlock;

		const prosemirror = portableTextToProsemirror([legacy]);
		const result = prosemirrorToPortableText(prosemirror);

		expect(prosemirror.content[0]?.type).toBe("table");
		expect(result[0]).toMatchObject({
			_type: "table",
			_key: "legacy-table",
			rows: [
				{
					_key: "legacy-row",
					cells: [
						{ _type: "tableCell", content: [{ _type: "span", text: "Name" }] },
						{ _type: "tableCell", content: [{ _type: "span", text: "Value" }] },
					],
				},
			],
		});
	});

	it("keeps a hard break outside the link mark that precedes it", () => {
		const result = prosemirrorToPortableText({
			type: "doc",
			content: [
				{
					type: "table",
					attrs: { emdashKey: "table" },
					content: [
						{
							type: "tableRow",
							attrs: { emdashKey: "row" },
							content: [
								{
									type: "tableCell",
									attrs: { emdashKey: "cell" },
									content: [
										{
											type: "paragraph",
											content: [
												{
													type: "text",
													text: "Linked",
													marks: [{ type: "link", attrs: { href: "https://example.com" } }],
												},
												{ type: "hardBreak" },
												{ type: "text", text: "Plain" },
											],
										},
									],
								},
							],
						},
					],
				},
			],
		});
		const content = (
			result[0] as {
				rows: Array<{ cells: Array<{ content: Array<{ text: string; marks?: string[] }> }> }>;
			}
		).rows[0]!.cells[0]!.content;

		expect(content.map((entry) => entry.text)).toEqual(["Linked", "\n", "Plain"]);
		expect(content[0]!.marks).toHaveLength(1);
		expect(content[1]!.marks).toBeUndefined();
		expect(content[2]!.marks).toBeUndefined();
	});

	it("rejects unsupported inline table atoms instead of replacing them with empty text", () => {
		const raw = {
			type: "doc" as const,
			content: [
				{
					type: "table",
					content: [
						{
							type: "tableRow",
							content: [
								{
									type: "tableCell",
									content: [
										{
											type: "paragraph",
											content: [{ type: "image", attrs: { src: "/valuable.png" } }],
										},
									],
								},
							],
						},
					],
				},
			],
		};

		let error: unknown;
		try {
			prosemirrorToPortableText(raw);
		} catch (caught) {
			error = caught;
		}
		expect(error).toMatchObject({
			name: "UnsafePortableTextTableError",
			reason: "UNSUPPORTED_CELL_CONTENT",
		});
	});

	it("rejects malformed tables instead of returning an editable partial document", () => {
		const raw = { _type: "table", _key: "unsafe", rows: "not-an-array" };

		let error: unknown;
		try {
			portableTextToProsemirror([raw as unknown as PortableTextBlock]);
		} catch (caught) {
			error = caught;
		}

		expect(error).toMatchObject({
			name: "UnsafePortableTextTableError",
			code: "UNSAFE_PORTABLE_TEXT_TABLE",
			reason: "INVALID_TABLE",
			raw,
		});
	});
});
