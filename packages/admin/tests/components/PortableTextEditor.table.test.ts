import { describe, it, expect } from "vitest";

import {
	_portableTextToProsemirror,
	_prosemirrorToPortableText,
} from "../../src/components/PortableTextEditor";

describe("Table conversion: PortableText ↔ ProseMirror", () => {
	describe("PortableText → ProseMirror", () => {
		it("converts simple table with text", () => {
			const ptBlocks = [
				{
					_type: "table",
					_key: "t1",
					hasHeaderRow: true,
					rows: [
						{
							_type: "tableRow",
							_key: "r1",
							cells: [
								{
									_type: "tableCell",
									_key: "c1",
									isHeader: true,
									content: [{ _type: "span", _key: "s1", text: "Header 1" }],
								},
								{
									_type: "tableCell",
									_key: "c2",
									isHeader: true,
									content: [{ _type: "span", _key: "s2", text: "Header 2" }],
								},
							],
						},
						{
							_type: "tableRow",
							_key: "r2",
							cells: [
								{
									_type: "tableCell",
									_key: "c3",
									content: [{ _type: "span", _key: "s3", text: "Cell 1" }],
								},
								{
									_type: "tableCell",
									_key: "c4",
									content: [{ _type: "span", _key: "s4", text: "Cell 2" }],
								},
							],
						},
					],
				},
			];

			const result = _portableTextToProsemirror(ptBlocks);

			expect(result.type).toBe("doc");
			expect(result.content).toHaveLength(1);

			const table = result.content[0];
			expect(table.type).toBe("table");
			expect(table.content).toHaveLength(2);

			const headerRow = table.content[0];
			expect(headerRow.type).toBe("tableRow");
			expect(headerRow.content[0].type).toBe("tableHeader");
			expect(headerRow.content[1].type).toBe("tableHeader");

			const dataRow = table.content[1];
			expect(dataRow.type).toBe("tableRow");
			expect(dataRow.content[0].type).toBe("tableCell");
		});

		it("converts table with text formatting marks", () => {
			const ptBlocks = [
				{
					_type: "table",
					_key: "t1",
					rows: [
						{
							_type: "tableRow",
							_key: "r1",
							cells: [
								{
									_type: "tableCell",
									_key: "c1",
									content: [{ _type: "span", _key: "s1", text: "Bold", marks: ["strong"] }],
								},
								{
									_type: "tableCell",
									_key: "c2",
									content: [{ _type: "span", _key: "s2", text: "Italic", marks: ["em"] }],
								},
							],
						},
					],
				},
			];

			const result = _portableTextToProsemirror(ptBlocks);

			const table = result.content[0];
			const cell1 = table.content[0].content[0];
			const cell1Para = cell1.content[0];
			const cell1Text = cell1Para.content[0];

			expect(cell1Text.text).toBe("Bold");
			expect(cell1Text.marks).toContainEqual({ type: "bold" });

			const cell2 = table.content[0].content[1];
			const cell2Para = cell2.content[0];
			const cell2Text = cell2Para.content[0];

			expect(cell2Text.text).toBe("Italic");
			expect(cell2Text.marks).toContainEqual({ type: "italic" });
		});

		it("converts table with links (markDefs)", () => {
			const ptBlocks = [
				{
					_type: "table",
					_key: "t1",
					markDefs: [
						{
							_type: "link",
							_key: "link1",
							href: "https://example.com",
							blank: true,
						},
					],
					rows: [
						{
							_type: "tableRow",
							_key: "r1",
							cells: [
								{
									_type: "tableCell",
									_key: "c1",
									content: [{ _type: "span", _key: "s1", text: "Click here", marks: ["link1"] }],
								},
							],
						},
					],
				},
			];

			const result = _portableTextToProsemirror(ptBlocks);

			const table = result.content[0];
			const cell = table.content[0].content[0];
			const para = cell.content[0];
			const text = para.content[0];

			expect(text.text).toBe("Click here");
			expect(text.marks).toContainEqual({
				type: "link",
				attrs: { href: "https://example.com", target: "_blank" },
			});
		});
	});

	describe("ProseMirror → PortableText", () => {
		it("converts simple table to PT", () => {
			const pmDoc = {
				type: "doc",
				content: [
					{
						type: "table",
						content: [
							{
								type: "tableRow",
								content: [
									{
										type: "tableHeader",
										content: [
											{
												type: "paragraph",
												content: [{ type: "text", text: "Header 1" }],
											},
										],
									},
									{
										type: "tableHeader",
										content: [
											{
												type: "paragraph",
												content: [{ type: "text", text: "Header 2" }],
											},
										],
									},
								],
							},
							{
								type: "tableRow",
								content: [
									{
										type: "tableCell",
										content: [
											{
												type: "paragraph",
												content: [{ type: "text", text: "Cell 1" }],
											},
										],
									},
									{
										type: "tableCell",
										content: [
											{
												type: "paragraph",
												content: [{ type: "text", text: "Cell 2" }],
											},
										],
									},
								],
							},
						],
					},
				],
			};

			const result = _prosemirrorToPortableText(pmDoc);

			expect(result).toHaveLength(1);
			const table = result[0] as {
				_type: string;
				rows: Array<{
					cells: Array<{ content: Array<{ text: string }>; isHeader: boolean }>;
				}>;
				hasHeaderRow: boolean;
			};

			expect(table._type).toBe("table");
			expect(table.hasHeaderRow).toBe(true);
			expect(table.rows).toHaveLength(2);
			expect(table.rows[0].cells[0].isHeader).toBe(true);
			expect(table.rows[0].cells[0].content[0].text).toBe("Header 1");
			expect(table.rows[1].cells[0].isHeader).toBe(false);
			expect(table.rows[1].cells[0].content[0].text).toBe("Cell 1");
		});

		it("converts table with text marks to PT", () => {
			const pmDoc = {
				type: "doc",
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
												content: [
													{
														type: "text",
														text: "Bold text",
														marks: [{ type: "bold" }],
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

			const result = _prosemirrorToPortableText(pmDoc);

			const table = result[0] as {
				rows: Array<{
					cells: Array<{ content: Array<{ text: string; marks?: string[] }> }>;
				}>;
			};

			expect(table.rows[0].cells[0].content[0].text).toBe("Bold text");
			expect(table.rows[0].cells[0].content[0].marks).toContain("strong");
		});

		it("converts table with links to PT (preserves markDefs)", () => {
			const pmDoc = {
				type: "doc",
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
												content: [
													{
														type: "text",
														text: "Link text",
														marks: [
															{
																type: "link",
																attrs: {
																	href: "https://example.com",
																	target: "_blank",
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
					},
				],
			};

			const result = _prosemirrorToPortableText(pmDoc);

			const table = result[0] as {
				markDefs?: Array<{ _type: string; href: string; blank?: boolean }>;
				rows: Array<{
					cells: Array<{ content: Array<{ text: string; marks?: string[] }> }>;
				}>;
			};

			expect(table.markDefs).toBeDefined();
			expect(table.markDefs).toHaveLength(1);
			expect(table.markDefs![0]._type).toBe("link");
			expect(table.markDefs![0].href).toBe("https://example.com");

			const linkMarkKey = table.markDefs![0]._key;
			expect(table.rows[0].cells[0].content[0].marks).toContain(linkMarkKey);
		});
	});

	describe("Round-trip conversion", () => {
		it("PT → PM → PT preserves table structure", () => {
			const original = [
				{
					_type: "table",
					_key: "t1",
					hasHeaderRow: true,
					rows: [
						{
							_type: "tableRow",
							_key: "r1",
							cells: [
								{
									_type: "tableCell",
									_key: "c1",
									isHeader: true,
									content: [{ _type: "span", _key: "s1", text: "Header" }],
								},
							],
						},
						{
							_type: "tableRow",
							_key: "r2",
							cells: [
								{
									_type: "tableCell",
									_key: "c2",
									content: [{ _type: "span", _key: "s2", text: "Data" }],
								},
							],
						},
					],
				},
			];

			const pm = _portableTextToProsemirror(original);
			const roundTripped = _prosemirrorToPortableText(pm);

			const table = roundTripped[0] as {
				_type: string;
				hasHeaderRow: boolean;
				rows: Array<{
					cells: Array<{ content: Array<{ text: string }>; isHeader: boolean }>;
				}>;
			};

			expect(table._type).toBe("table");
			expect(table.hasHeaderRow).toBe(true);
			expect(table.rows[0].cells[0].isHeader).toBe(true);
			expect(table.rows[0].cells[0].content[0].text).toBe("Header");
			expect(table.rows[1].cells[0].isHeader).toBe(false);
			expect(table.rows[1].cells[0].content[0].text).toBe("Data");
		});
	});
});
