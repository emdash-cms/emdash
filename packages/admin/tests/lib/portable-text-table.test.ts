import { describe, expect, it, vi } from "vitest";

import {
	MAX_TABLE_REPAIRED_SLOTS,
	UnsafePortableTextTableError,
	getPortableTextTableCellMarkDefs,
	getPortableTextTableColumnWidths,
	isPortableTextTableInput,
	normalizePortableTextTable,
	portableTextTableToProseMirror,
	proseMirrorTableToPortableText,
	type PortableTextTableBlock,
} from "../../src/portable-text-table";

function keyFactory(prefix = "new") {
	let next = 0;
	return () => `${prefix}-${next++}`;
}

function span(key: string, text: string, marks?: string[]) {
	return { _type: "span" as const, _key: key, text, marks };
}

function cell(key: string, text: string) {
	return {
		_type: "tableCell" as const,
		_key: key,
		content: [span(`${key}-span`, text)],
	};
}

function row(key: string, cells: unknown[]) {
	return { _type: "tableRow" as const, _key: key, cells };
}

describe("Portable Text table normalization", () => {
	it.each([16, 64])("indexes shared annotations linearly for %i cells", (size) => {
		const markDefs = Array.from({ length: size }, (_, index) => ({
			_type: "link",
			_key: `shared-link-${index}`,
			href: `/shared/${index}`,
			source: "import",
		}));
		const source = {
			_type: "table",
			_key: "indexed",
			markDefs,
			rows: [
				row(
					"row",
					Array.from({ length: size }, (_, index) => ({
						...cell(`cell-${index}`, "Linked"),
						content: [span(`span-${index}`, "Linked", ["shared-link-0"])],
						markDefs: [{ ...markDefs[0]!, href: `/local/${index}` }],
					})),
				),
			],
		};
		let writes = 0;
		let resolvedDefinitions = 0;
		const context = { path: "root:indexed", createKey: keyFactory() };
		const originalSet = Map.prototype.set;
		const set = vi.spyOn(Map.prototype, "set").mockImplementation(function (key, value) {
			if (typeof key === "string" && key.startsWith("shared-link-")) writes++;
			return originalSet.call(this, key, value);
		});
		try {
			const converted = portableTextTableToProseMirror(source, {
				...context,
				spansToInline: (_content, resolved) => {
					resolvedDefinitions += resolved.length;
					return [{ type: "text", text: String(resolved[0]?.href) }];
				},
			});
			expect(converted.ok).toBe(true);
			if (!converted.ok) return;
			expect(
				converted.node.content[0]!.content.map((entry) => entry.content[0]!.content[0]!.text),
			).toEqual(Array.from({ length: size }, (_, index) => `/local/${index}`));
			expect(writes).toBeLessThanOrEqual(size * 8);
			expect(resolvedDefinitions).toBe(size);
		} finally {
			set.mockRestore();
		}
		const normalized = normalizePortableTextTable(source, context);
		expect(normalized.ok).toBe(true);
		if (!normalized.ok) return;
		expect(normalized.table.markDefs).toEqual(markDefs);
		expect(normalized.table.rows[0]!.cells.map((entry) => entry.markDefs)).toEqual(
			source.rows[0]!.cells.map((entry) => entry.markDefs),
		);
	});

	it("recognizes only table-shaped inputs", () => {
		expect(isPortableTextTableInput({ _type: "table", rows: [] })).toBe(true);
		expect(isPortableTextTableInput({ _type: "image", rows: [] })).toBe(false);
		expect(isPortableTextTableInput(null)).toBe(false);
	});

	it("preserves canonical content, structural keys, marks, and safe opaque metadata", () => {
		const input = {
			_type: "table",
			_key: "table-key",
			caption: "Quarterly totals",
			only: "metadata, not an event handler",
			style: "width: expression(alert(1))",
			"data-owner": "unsafe-dom-data",
			onwheel: "unsafe-handler",
			markDefs: [{ _type: "link", _key: "shared-link", href: "https://table.test" }],
			rows: [
				{
					_type: "tableRow",
					_key: "header-row",
					kind: "summary",
					cells: [
						{
							_type: "tableCell",
							_key: "header-cell",
							isHeader: true,
							colspan: 2,
							colwidth: [160, 224],
							textAlign: "center",
							source: { system: "import" },
							markDefs: [{ _type: "link", _key: "shared-link", href: "https://cell.test" }],
							content: [span("header-span", "Report", ["strong", "shared-link"])],
						},
					],
				},
			],
		};
		const original = structuredClone(input);

		const result = normalizePortableTextTable(input, {
			path: "root:0",
			createKey: keyFactory(),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(input).toEqual(original);
		expect(result).toMatchObject({ width: 2, height: 1 });
		expect(result.table).toMatchObject({
			_key: "table-key",
			caption: "Quarterly totals",
			only: "metadata, not an event handler",
			hasHeaderRow: true,
			rows: [
				{
					_key: "header-row",
					kind: "summary",
					cells: [
						{
							_key: "header-cell",
							isHeader: true,
							colspan: 2,
							colwidth: [160, 224],
							textAlign: "center",
							source: { system: "import" },
							content: [{ _key: "header-span", text: "Report" }],
						},
					],
				},
			],
		});
		expect(result.table).not.toHaveProperty("style");
		expect(result.table).not.toHaveProperty("data-owner");
		expect(result.table).not.toHaveProperty("onwheel");
		expect(getPortableTextTableCellMarkDefs(result.table, result.table.rows[0]!.cells[0]!)).toEqual(
			[{ _type: "link", _key: "shared-link", href: "https://cell.test" }],
		);
		expect(getPortableTextTableColumnWidths(result.table)).toEqual([160, 224]);
	});

	it("normalizes legacy string cells deterministically and preserves legacy header intent", () => {
		const input = {
			_type: "table",
			hasHeaderRow: true,
			rows: [
				{ _type: "tableRow", cells: [] },
				{ _type: "tableRow", cells: [" Name ", "القيمة"] },
			],
		};

		const first = normalizePortableTextTable(input, {
			path: "root:legacy",
			createKey: keyFactory("first"),
		});
		const second = normalizePortableTextTable(input, {
			path: "root:legacy",
			createKey: keyFactory("second"),
		});

		expect(first).toEqual(second);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.table.hasHeaderRow).toBeUndefined();
		expect(first.table.rows[1]!.cells.map((entry) => entry.content[0]!.text)).toEqual([
			" Name ",
			"القيمة",
		]);
		expect(first.table.rows[1]!.cells.every((entry) => entry.isHeader === true)).toBe(true);
		expect(first.table.rows[0]!.cells.every((entry) => entry.isHeader !== true)).toBe(true);
	});

	it("repairs duplicate keys and invalid attributes without inventing header state", () => {
		const result = normalizePortableTextTable(
			{
				_type: "table",
				_key: "duplicate",
				rows: [
					{
						_type: "tableRow",
						_key: "duplicate",
						cells: [
							{
								...cell("duplicate", "A"),
								colspan: 2,
								rowspan: 999,
								colwidth: [144, 0],
								textAlign: "start",
								isHeader: false,
							},
						],
					},
				],
			},
			{ path: "root:keys", createKey: keyFactory() },
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const keys = [
			result.table._key,
			result.table.rows[0]!._key,
			...result.table.rows[0]!.cells.map((entry) => entry._key),
		];
		expect(new Set(keys).size).toBe(keys.length);
		expect(result.table._key).toBe("duplicate");
		expect(result.table.rows[0]!.cells[0]).toMatchObject({
			colspan: 2,
			colwidth: [144, 96],
			isHeader: false,
		});
		expect(result.table.rows[0]!.cells[0]).not.toHaveProperty("rowspan");
		expect(result.table.rows[0]!.cells[0]).not.toHaveProperty("textAlign");
	});

	it("omits automatic-only widths and resolves automatic segments beside explicit widths", () => {
		const automaticOnly = normalizePortableTextTable(
			{
				_type: "table",
				rows: [row("row", [{ ...cell("cell", "A"), colwidth: [0] }])],
			},
			{ path: "root:auto", createKey: keyFactory() },
		);
		expect(automaticOnly.ok).toBe(true);
		if (!automaticOnly.ok) return;
		expect(automaticOnly.table.rows[0]!.cells[0]!.colwidth).toBeUndefined();
		expect(getPortableTextTableColumnWidths(automaticOnly.table)).toBeUndefined();

		const mixed = normalizePortableTextTable(
			{
				_type: "table",
				rows: [row("row", [{ ...cell("cell", "A"), colspan: 2, colwidth: [144, 0] }])],
			},
			{ path: "root:mixed", createKey: keyFactory() },
		);
		expect(mixed.ok).toBe(true);
		if (!mixed.ok) return;
		expect(mixed.table.rows[0]!.cells[0]!.colwidth).toEqual([144, 96]);
	});

	it("clamps rendered column widths without changing valid stored preferences", () => {
		const table = {
			_type: "table" as const,
			_key: "narrow-table",
			rows: [
				row(
					"narrow-row",
					Array.from({ length: 10 }, (_, index) => ({
						...cell(`narrow-${index}`, String(index)),
						colwidth: [1],
					})),
				),
			],
		};

		expect(getPortableTextTableColumnWidths(table)).toEqual(Array(10).fill(96));
		expect(table.rows[0]!.cells.every((entry) => entry.colwidth[0] === 1)).toBe(true);
	});

	it("repairs overlapping spans into a rectangular grid without dropping source content", () => {
		const result = normalizePortableTextTable(
			{
				_type: "table",
				_key: "spans",
				rows: [
					row("r0", [{ ...cell("a", "A"), colspan: 2, rowspan: 2 }, cell("b", "B")]),
					row("r1", [{ ...cell("c", "C"), colspan: 2 }]),
				],
			},
			{ path: "root:spans", createKey: keyFactory() },
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result).toMatchObject({ width: 4, height: 2 });
		const sourceText = result.table.rows
			.flatMap((entry) => entry.cells)
			.map((entry) => entry.content.map((child) => child.text).join(""))
			.filter(Boolean);
		expect(sourceText).toEqual(["A", "B", "C"]);
		expect(result.table.rows[0]!.cells).toHaveLength(3);
		expect(result.table.rows[1]!.cells).toHaveLength(1);
	});

	it("returns the untouched raw value and an unspanned fallback before repair exceeds its bound", () => {
		const cells = Array.from({ length: 201 }, (_, index) => ({
			...cell(`cell-${index}`, String(index)),
			colspan: 100,
		}));
		const input = { _type: "table", _key: "large", rows: [row("row", cells)] };

		const result = normalizePortableTextTable(input, {
			path: "root:large",
			createKey: keyFactory(),
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("TABLE_TOO_LARGE");
		expect(result.raw).toBe(input);
		expect(result.renderFallback).toBeUndefined();
	});

	it("bounds ordinary oversized grids before normalizing every source cell", () => {
		const columns = 100;
		const rows = Array.from(
			{ length: Math.floor(MAX_TABLE_REPAIRED_SLOTS / columns) + 1 },
			(_rowValue, rowIndex) =>
				row(
					`row-${rowIndex}`,
					Array.from({ length: columns }, (_cellValue, cellIndex) =>
						cell(`cell-${rowIndex}-${cellIndex}`, `${rowIndex}:${cellIndex}`),
					),
				),
		);
		const input = { _type: "table", _key: "large-grid", rows };
		Object.defineProperty(rows[0]!.cells[0]!, "_key", {
			get: () => {
				throw new Error("source cell was normalized before the size gate");
			},
		});

		const result = normalizePortableTextTable(input, {
			path: "root:large-grid",
			createKey: keyFactory(),
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("TABLE_TOO_LARGE");
		expect(result.raw).toBe(input);
		expect(result.renderFallback).toBeUndefined();
	});

	it.each(["cell", "row"])("keeps raw input when the fallback would omit its final %s", (end) => {
		const cells: unknown[] = Array(MAX_TABLE_REPAIRED_SLOTS - 1).fill("Body");
		cells[0] = { content: [{ _type: "block", children: [span("nested", "Recoverable")] }] };
		const input = { _type: "table", rows: [row("empty", []), row("body", cells)] };
		if (end === "cell") cells.push("Keep the last cell");
		else input.rows.push(row("last", ["Keep the last cell"]));

		const result = normalizePortableTextTable(input, {
			path: "root:fallback-limit",
			createKey: keyFactory(),
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("UNSUPPORTED_CELL_CONTENT");
		expect(result.raw).toBe(input);
		expect(result.renderFallback).toBeUndefined();
	});

	it("bounds oversized cell content before normalizing every span", () => {
		const content = Array.from({ length: MAX_TABLE_REPAIRED_SLOTS * 4 + 1 }, (_value, index) =>
			span(`span-${index}`, String(index)),
		);
		Object.defineProperty(content[0]!, "_key", {
			get: () => {
				throw new Error("source span was normalized before the size gate");
			},
		});
		const input = {
			_type: "table",
			_key: "large-content",
			rows: [row("row", [{ ...cell("cell", "unused"), content }])],
		};

		const result = normalizePortableTextTable(input, {
			path: "root:large-content",
			createKey: keyFactory(),
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("TABLE_TOO_LARGE");
		expect(result.raw).toBe(input);
		expect(result.renderFallback).toBeUndefined();
	});

	it("accepts a 100 by 100 table without treating inline nodes as geometry slots", () => {
		const rows = Array.from({ length: 100 }, (_row, rowIndex) =>
			row(
				`row-${rowIndex}`,
				Array.from({ length: 100 }, (_cell, cellIndex) =>
					cell(`cell-${rowIndex}-${cellIndex}`, "Value"),
				),
			),
		);

		const normalized = normalizePortableTextTable(
			{ _type: "table", _key: "boundary", rows },
			{ path: "root:boundary", createKey: keyFactory() },
		);
		expect(normalized).toMatchObject({ ok: true, width: 100, height: 100 });

		const proseMirror = portableTextTableToProseMirror(
			{ _type: "table", _key: "boundary", rows },
			{
				path: "root:boundary",
				createKey: keyFactory(),
				spansToInline: (content) => content.map((entry) => ({ type: "text", text: entry.text })),
			},
		);
		expect(proseMirror).toMatchObject({ ok: true, width: 100, height: 100 });
		if (!proseMirror.ok) return;

		const roundTripped = proseMirrorTableToPortableText(proseMirror.node, {
			path: "root:boundary",
			createKey: keyFactory(),
			inlineToSpans: (content) => ({
				content: content.map((entry, index) => span(`round-trip-${index}`, entry.text ?? "")),
			}),
		});
		expect(roundTripped).toMatchObject({ ok: true, width: 100, height: 100 });
	});

	it("refuses unsafe cell content and unsupported annotations instead of dropping them", () => {
		const unsafeContent = normalizePortableTextTable(
			{
				_type: "table",
				rows: [row("r", [{ ...cell("c", "safe"), content: [{ _type: "image", src: "x" }] }])],
			},
			{ path: "root:unsafe", createKey: keyFactory() },
		);
		expect(unsafeContent).toMatchObject({ ok: false, reason: "UNSUPPORTED_CELL_CONTENT" });

		const unsupportedMark = normalizePortableTextTable(
			{
				_type: "table",
				markDefs: [{ _type: "mention", _key: "mention", userId: "1" }],
				rows: [row("r", [{ ...cell("c", "name"), content: [span("s", "name", ["mention"])] }])],
			},
			{ path: "root:mark", createKey: keyFactory() },
		);
		expect(unsupportedMark).toMatchObject({ ok: false, reason: "UNSUPPORTED_MARK_DEFINITION" });
	});

	it("exposes a stable unsafe-table error without discarding the raw value", () => {
		const raw = { _type: "table", rows: "invalid" };
		const error = new UnsafePortableTextTableError("INVALID_TABLE", raw);

		expect(error).toBeInstanceOf(Error);
		expect(error.code).toBe("UNSAFE_PORTABLE_TEXT_TABLE");
		expect(error.reason).toBe("INVALID_TABLE");
		expect(error.raw).toBe(raw);
	});
});

describe("Portable Text table plain-JSON adapters", () => {
	it("bounds oversized ProseMirror tables before converting every cell", () => {
		const cells = Array.from({ length: MAX_TABLE_REPAIRED_SLOTS + 1 }, () => ({
			type: "tableCell",
			attrs: {},
			content: [{ type: "paragraph" }],
		}));
		Object.defineProperty(cells[0]!.attrs, "emdashKey", {
			get: () => {
				throw new Error("ProseMirror cell was converted before the size gate");
			},
		});

		const result = proseMirrorTableToPortableText(
			{
				type: "table",
				content: [{ type: "tableRow", content: cells }],
			},
			{
				path: "root:large-pm",
				createKey: keyFactory(),
				inlineToSpans: () => ({ content: [] }),
			},
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("TABLE_TOO_LARGE");
	});

	it("converts normalized Portable Text into keyed ProseMirror table JSON", () => {
		const source: PortableTextTableBlock = {
			_type: "table",
			_key: "table",
			topic: "finance",
			rows: [
				{
					_type: "tableRow",
					_key: "row",
					cells: [
						{
							...cell("cell", "Revenue"),
							isHeader: true,
							textAlign: "right",
							origin: "import",
						},
					],
				},
			],
		};

		const result = portableTextTableToProseMirror(source, {
			path: "root:0",
			createKey: keyFactory(),
			spansToInline: (content) => content.map((entry) => ({ type: "text", text: entry.text })),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.node).toMatchObject({
			type: "table",
			attrs: { emdashKey: "table", emdashData: { topic: "finance" } },
			content: [
				{
					type: "tableRow",
					attrs: { emdashKey: "row", emdashData: {} },
					content: [
						{
							type: "tableHeader",
							attrs: {
								emdashKey: "cell",
								emdashData: { origin: "import" },
								textAlign: "right",
							},
							content: [{ type: "paragraph", content: [{ type: "text", text: "Revenue" }] }],
						},
					],
				},
			],
		});
	});

	it("converts ProseMirror tables back without losing multiple paragraph contents", () => {
		const result = proseMirrorTableToPortableText(
			{
				type: "table",
				attrs: { emdashKey: "table", emdashData: { topic: "finance" } },
				content: [
					{
						type: "tableRow",
						attrs: { emdashKey: "row" },
						content: [
							{
								type: "tableCell",
								attrs: {
									emdashKey: "cell",
									emdashData: { origin: "import" },
									colspan: 2,
									colwidth: [160, 0],
									textAlign: "center",
								},
								content: [
									{ type: "paragraph", content: [{ type: "text", text: "First" }] },
									{ type: "paragraph", content: [{ type: "text", text: "Second" }] },
								],
							},
						],
					},
				],
			},
			{
				path: "root:0",
				createKey: keyFactory("generated"),
				inlineToSpans: (content) => ({
					content: [
						span(
							`inline-${String((content[0] as { text?: string } | undefined)?.text)}`,
							String((content[0] as { text?: string } | undefined)?.text ?? ""),
						),
					],
					markDefs: [],
				}),
			},
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.table).toMatchObject({
			_key: "table",
			topic: "finance",
			rows: [
				{
					_key: "row",
					cells: [
						{
							_key: "cell",
							origin: "import",
							colspan: 2,
							colwidth: [160, 96],
							textAlign: "center",
							content: [{ text: "First" }, { text: "\n" }, { text: "Second" }],
						},
					],
				},
			],
		});
	});
});
