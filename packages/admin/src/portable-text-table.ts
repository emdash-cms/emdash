export const MAX_TABLE_SPAN = 100;
export const MAX_TABLE_COLUMN_WIDTH = 4096;
export const TABLE_CELL_MIN_WIDTH = 96;
export const TABLE_COLUMN_WIDTH_STEP = 16;
export const TABLE_RESIZE_HANDLE_WIDTH = 2;
export const TABLE_RESIZE_TARGET_WIDTH = 24;
export const MAX_TABLE_REPAIRED_SLOTS = 20_000;
export const MAX_TABLE_PASTE_ROWS = 100;
export const MAX_TABLE_PASTE_COLUMNS = 100;
export const MAX_TABLE_PASTE_CELLS = 10_000;
export const MAX_TABLE_PASTE_TEXT_BYTES = 1_048_576;
const MAX_TABLE_SOURCE_ENTRIES = MAX_TABLE_REPAIRED_SLOTS * 4;

export type PortableTextTableAlignment = "left" | "center" | "right" | "justify";

export type PortableTextTableSpan = { _type: "span"; _key: string; text: string; marks?: string[] };

export type PortableTextTableMarkDef = { _type: string; _key: string; [key: string]: unknown };

export interface PortableTextTableCell {
	_type: "tableCell";
	_key: string;
	content: PortableTextTableSpan[];
	markDefs?: PortableTextTableMarkDef[];
	isHeader?: boolean;
	colspan?: number;
	rowspan?: number;
	colwidth?: number[];
	textAlign?: PortableTextTableAlignment;
	[key: string]: unknown;
}

export interface PortableTextTableRow {
	_type: "tableRow";
	_key: string;
	cells: PortableTextTableCell[];
	[key: string]: unknown;
}

export interface PortableTextTableBlock {
	_type: "table";
	_key: string;
	rows: PortableTextTableRow[];
	hasHeaderRow?: boolean;
	markDefs?: PortableTextTableMarkDef[];
	[key: string]: unknown;
}

export interface PortableTextTableProseMirrorNode {
	type: string;
	attrs?: Record<string, unknown>;
	content?: PortableTextTableProseMirrorNode[];
	marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
	text?: string;
}

export type UnsafePortableTextTableReason =
	| "INVALID_TABLE"
	| "TABLE_TOO_LARGE"
	| "UNSUPPORTED_CELL_CONTENT"
	| "UNSUPPORTED_MARK_DEFINITION";

type PortableTextTableContext = { path: string; createKey: () => string };

interface PortableTextTableToProseMirrorContext extends PortableTextTableContext {
	spansToInline: (
		content: PortableTextTableSpan[],
		markDefs: PortableTextTableMarkDef[],
	) => PortableTextTableProseMirrorNode[];
}

interface ProseMirrorTableToPortableTextContext extends PortableTextTableContext {
	inlineToSpans: (content: PortableTextTableProseMirrorNode[]) => {
		content: PortableTextTableSpan[];
		markDefs?: PortableTextTableMarkDef[];
	};
}

type UnknownRecord = Record<string, unknown>;
type PlacedCell = { cell: PortableTextTableCell; column: number };
type SourceRow = {
	row: UnknownRecord & { _type: "tableRow"; _key: string };
	cells: PortableTextTableCell[];
};

class NormalizationFailure extends Error {
	constructor(readonly reason: UnsafePortableTextTableReason) {
		super();
	}
}

const fail = (reason: UnsafePortableTextTableReason): never => {
	throw new NormalizationFailure(reason);
};

const DECORATOR_MARKS = new Set(
	"strong em underline strike-through subscript superscript code".split(" "),
);
const TABLE_FIELDS = new Set("_type _key rows hasHeaderRow markDefs".split(" "));
const ROW_FIELDS = new Set("_type _key cells".split(" "));
const CELL_FIELDS = new Set(
	"_type _key content markDefs isHeader colspan rowspan colwidth textAlign".split(" "),
);
const DOM_FIELD =
	/^(?:aria-|data-|class(?:name)?$|id$|role$|style$|on(?:animation(?:end|iteration|start)|beforeinput|blur|change|click|contextmenu|copy|cut|drag|drop|error|focus|input|key(?:down|press|up)|load|mouse(?:down|move|up)|paste|pointer(?:down|move|up)|scroll|submit|touch(?:end|move|start)|transition(?:cancel|end|run|start)|wheel)$)/i;

export class UnsafePortableTextTableError extends Error {
	readonly code = "UNSAFE_PORTABLE_TEXT_TABLE";

	constructor(
		readonly reason: UnsafePortableTextTableReason,
		readonly raw: unknown,
		readonly renderFallback?: PortableTextTableBlock,
	) {
		super(`Unsafe Portable Text table: ${reason}`);
		this.name = "UnsafePortableTextTableError";
	}
}

export function isPortableTextTableInput(
	value: unknown,
): value is UnknownRecord & { _type: "table" } {
	return isRecord(value) && value._type === "table";
}

export function normalizePortableTextTable(value: unknown, context: PortableTextTableContext) {
	return catchFailure(value, context, () => normalizeTable(value, context));
}

function normalizeTable(value: unknown, context: PortableTextTableContext) {
	if (
		!isPortableTextTableInput(value) ||
		(value.rows !== undefined && !Array.isArray(value.rows))
	) {
		return fail("INVALID_TABLE");
	}

	const rawRows = Array.isArray(value.rows) ? value.rows : [];
	let sourceCells = 0;
	let sourceEntries = rawRows.length + (Array.isArray(value.markDefs) ? value.markDefs.length : 0);
	for (const row of rawRows) {
		if (!isRecord(row) || !Array.isArray(row.cells)) continue;
		sourceCells += row.cells.length;
		sourceEntries += row.cells.length;
		for (const cell of row.cells) {
			if (!isRecord(cell)) continue;
			if (Array.isArray(cell.content)) sourceEntries += cell.content.length;
			if (Array.isArray(cell.markDefs)) sourceEntries += cell.markDefs.length;
		}
		if (sourceCells > MAX_TABLE_REPAIRED_SLOTS || sourceEntries > MAX_TABLE_SOURCE_ENTRIES) {
			return fail("TABLE_TOO_LARGE");
		}
	}
	if (sourceEntries > MAX_TABLE_SOURCE_ENTRIES) return fail("TABLE_TOO_LARGE");
	const seen = new Set<string>();
	const tableKey = reserveKey(readKey(value._key) ?? legacyKey(`${context.path}:table`), seen);
	const tableMarkDefs = normalizeMarkDefs(value.markDefs);
	const tableMarks = indexMarkDefs(tableMarkDefs);
	const firstContentRow = rawRows.findIndex(
		(row) => isRecord(row) && Array.isArray(row.cells) && row.cells.length > 0,
	);
	const firstCells =
		firstContentRow >= 0 && isRecord(rawRows[firstContentRow])
			? rawRows[firstContentRow].cells
			: undefined;
	const promoteHeader =
		value.hasHeaderRow === true &&
		Array.isArray(firstCells) &&
		!firstCells.some((cell) => isRecord(cell) && hasOwn(cell, "isHeader"));

	const sourceRows: SourceRow[] = rawRows.map((rawRow, rowIndex) => {
		const record = asRecord(rawRow);
		const rowKey = reserveKey(
			readKey(record._key) ?? legacyKey(`${tableKey}:row:${rowIndex}`),
			seen,
		);
		const rawCells = Array.isArray(record.cells) ? record.cells : [];
		return {
			row: { ...safeFields(record, ROW_FIELDS), _type: "tableRow", _key: rowKey },
			cells: rawCells.map((cell, cellIndex) =>
				normalizeCell(cell, {
					path: `${rowKey}:cell:${cellIndex}`,
					remainingRows: rawRows.length - rowIndex,
					promoteHeader: promoteHeader && rowIndex === firstContentRow,
					seen,
					tableMarks,
				}),
			),
		};
	});

	if (!sourceRows.some((row) => row.cells.length > 0)) {
		const rowKey = reserveKey(legacyKey(`${tableKey}:repair-row:0`), seen);
		const cell = emptyCell(reserveKey(legacyKey(`${tableKey}:repair-cell:0:0`), seen));
		return {
			ok: true as const,
			table: tableFrom(value, tableKey, tableMarkDefs, [
				{ _type: "tableRow", _key: rowKey, cells: [cell] },
			]),
			width: 1,
			height: 1,
		};
	}

	const height = sourceRows.length;
	const occupied = Array.from({ length: height }, () => new Set<number>());
	const placed = Array.from({ length: height }, () => [] as PlacedCell[]);
	let width = 0;
	for (let row = 0; row < height; row++) {
		let cursor = 0;
		for (const cell of sourceRows[row]!.cells) {
			const colspan = cell.colspan ?? 1;
			const rowspan = cell.rowspan ?? 1;
			while (!rectangleFree(occupied, row, cursor, rowspan, colspan)) {
				assertGridBound(++cursor + colspan, height);
			}
			assertGridBound(Math.max(width, cursor + colspan), height);
			occupy(occupied, row, cursor, rowspan, colspan);
			placed[row]!.push({ cell, column: cursor });
			cursor += colspan;
			width = Math.max(width, cursor);
		}
	}

	const columnWidths: Array<number | undefined> = Array.from({ length: width });
	for (const row of placed) {
		for (const { cell, column } of row) {
			for (let offset = 0; offset < (cell.colspan ?? 1); offset++) {
				const candidate = cell.colwidth?.[offset];
				if (candidate && columnWidths[column + offset] === undefined) {
					columnWidths[column + offset] = candidate;
				}
			}
		}
	}
	const hasWidths = columnWidths.some((entry) => entry !== undefined);
	if (hasWidths) {
		for (let column = 0; column < width; column++) columnWidths[column] ??= TABLE_CELL_MIN_WIDTH;
	}

	const rows = sourceRows.map((source, rowIndex): PortableTextTableRow => {
		const anchors = new Map(placed[rowIndex]!.map(({ cell, column }) => [column, cell]));
		const headers = source.cells.length > 0 && source.cells.every((cell) => cell.isHeader === true);
		const cells: PortableTextTableCell[] = [];
		for (let column = 0; column < width;) {
			const anchored = anchors.get(column);
			if (anchored) {
				const span = anchored.colspan ?? 1;
				cells.push(withWidths(anchored, column, span, columnWidths, hasWidths));
				column += span;
			} else if (occupied[rowIndex]!.has(column)) {
				column++;
			} else {
				const key = reserveKey(legacyKey(`${tableKey}:repair-cell:${rowIndex}:${column}`), seen);
				cells.push(withWidths(emptyCell(key, headers), column++, 1, columnWidths, hasWidths));
			}
		}
		return { ...source.row, cells };
	});
	const hasHeaderRow =
		sourceRows[0]!.cells.length > 0 &&
		rows[0]!.cells.every((cell) => cell.isHeader === true && (cell.rowspan ?? 1) === 1);
	return {
		ok: true as const,
		table: tableFrom(value, tableKey, tableMarkDefs, rows, hasHeaderRow),
		width,
		height,
	};
}

export function portableTextTableToProseMirror(
	value: unknown,
	context: PortableTextTableToProseMirrorContext,
) {
	const normalized = normalizePortableTextTable(value, context);
	if (!normalized.ok) return normalized;
	const { table } = normalized;
	const resolveCellMarkDefs = createPortableTextTableCellMarkResolver(table);
	return {
		ok: true as const,
		width: normalized.width,
		height: normalized.height,
		node: {
			type: "table",
			attrs: pmAttrs(table, TABLE_FIELDS),
			content: table.rows.map((row) => ({
				type: "tableRow",
				attrs: pmAttrs(row, ROW_FIELDS),
				content: row.cells.map((cell) => ({
					type: cell.isHeader ? "tableHeader" : "tableCell",
					attrs: {
						colspan: cell.colspan ?? 1,
						rowspan: cell.rowspan ?? 1,
						colwidth: cell.colwidth ?? null,
						textAlign: cell.textAlign ?? null,
						...pmAttrs(cell, CELL_FIELDS),
					},
					content: [
						{
							type: "paragraph",
							content: context.spansToInline(cell.content, resolveCellMarkDefs(cell)),
						},
					],
				})),
			})),
		},
	};
}

export function proseMirrorTableToPortableText(
	value: unknown,
	context: ProseMirrorTableToPortableTextContext,
) {
	return catchFailure(value, context, () => {
		if (!isRecord(value) || value.type !== "table" || !Array.isArray(value.content)) {
			return fail("INVALID_TABLE");
		}
		let sourceCells = 0;
		let sourceEntries = value.content.length;
		for (const row of value.content) {
			if (!isRecord(row) || !Array.isArray(row.content)) continue;
			sourceCells += row.content.length;
			sourceEntries += row.content.length;
			for (const cell of row.content) {
				if (!isRecord(cell) || !Array.isArray(cell.content)) continue;
				sourceEntries += cell.content.length;
				for (const paragraph of cell.content) {
					if (isRecord(paragraph) && Array.isArray(paragraph.content)) {
						sourceEntries += paragraph.content.length;
					}
				}
			}
			if (sourceCells > MAX_TABLE_REPAIRED_SLOTS || sourceEntries > MAX_TABLE_SOURCE_ENTRIES) {
				return fail("TABLE_TOO_LARGE");
			}
		}
		const tableAttrs = asRecord(value.attrs);
		const rows = value.content.map((row): UnknownRecord => {
			if (!isRecord(row) || row.type !== "tableRow" || !Array.isArray(row.content)) {
				return fail("INVALID_TABLE");
			}
			const attrs = asRecord(row.attrs);
			return {
				...safeFields(attrs.emdashData),
				_type: "tableRow",
				_key: readKey(attrs.emdashKey) ?? context.createKey(),
				cells: row.content.map((cell) => pmCell(cell, context)),
			};
		});
		return normalizeTable(
			{
				...safeFields(tableAttrs.emdashData),
				_type: "table",
				_key: readKey(tableAttrs.emdashKey) ?? context.createKey(),
				rows,
			},
			context,
		);
	});
}

function pmCell(value: unknown, context: ProseMirrorTableToPortableTextContext): UnknownRecord {
	if (
		!isRecord(value) ||
		(value.type !== "tableCell" && value.type !== "tableHeader") ||
		!Array.isArray(value.content)
	) {
		return fail("UNSUPPORTED_CELL_CONTENT");
	}
	const attrs = asRecord(value.attrs);
	const content: PortableTextTableSpan[] = [];
	const markDefs: PortableTextTableMarkDef[] = [];
	for (let index = 0; index < value.content.length; index++) {
		const paragraph = value.content[index];
		if (!isRecord(paragraph) || paragraph.type !== "paragraph") {
			return fail("UNSUPPORTED_CELL_CONTENT");
		}
		const inline = Array.isArray(paragraph.content) ? paragraph.content : [];
		if (
			!inline.every(
				(node) => isProseMirrorNode(node) && (node.type === "text" || node.type === "hardBreak"),
			)
		) {
			return fail("UNSUPPORTED_CELL_CONTENT");
		}
		const converted = context.inlineToSpans(inline);
		if (index > 0) content.push({ _type: "span", _key: context.createKey(), text: "\n" });
		content.push(...converted.content);
		markDefs.push(...(converted.markDefs ?? []));
	}
	return {
		...safeFields(attrs.emdashData),
		_type: "tableCell",
		_key: readKey(attrs.emdashKey) ?? context.createKey(),
		content,
		...(markDefs.length > 0 ? { markDefs } : {}),
		isHeader: value.type === "tableHeader",
		colspan: attrs.colspan,
		rowspan: attrs.rowspan,
		colwidth: attrs.colwidth,
		textAlign: attrs.textAlign,
	};
}

export function getPortableTextTableCellMarkDefs(
	table: PortableTextTableBlock,
	cell: PortableTextTableCell,
): PortableTextTableMarkDef[] {
	return getMarkDefs(table.markDefs ?? [], cell.markDefs ?? []);
}

export function createPortableTextTableCellMarkResolver(table: PortableTextTableBlock) {
	const shared = indexMarkDefs(table.markDefs ?? []);
	return (cell: PortableTextTableCell): PortableTextTableMarkDef[] => {
		const local = indexMarkDefs(cell.markDefs ?? []);
		const referenced = new Map<string, PortableTextTableMarkDef>();
		for (const span of cell.content) {
			for (const key of span.marks ?? []) {
				const definition = local.get(key) ?? shared.get(key);
				if (definition) referenced.set(key, definition);
			}
		}
		return [...referenced.values()];
	};
}

export function getPortableTextTableColumnWidths(
	table: PortableTextTableBlock,
): number[] | undefined {
	const occupied = Array.from({ length: table.rows.length }, () => new Set<number>());
	const widths: Array<number | undefined> = [];
	for (let row = 0; row < table.rows.length; row++) {
		let column = 0;
		for (const cell of table.rows[row]!.cells) {
			while (occupied[row]!.has(column)) column++;
			const colspan = cell.colspan ?? 1;
			for (let offset = 0; offset < colspan; offset++) {
				const value = cell.colwidth?.[offset];
				if (value && widths[column + offset] === undefined) {
					widths[column + offset] = Math.max(TABLE_CELL_MIN_WIDTH, value);
				}
			}
			occupy(occupied, row, column, cell.rowspan ?? 1, colspan);
			column += colspan;
		}
	}
	return widths.some(Boolean) ? widths.map((width) => width ?? TABLE_CELL_MIN_WIDTH) : undefined;
}

function normalizeCell(
	value: unknown,
	context: {
		path: string;
		remainingRows: number;
		promoteHeader: boolean;
		seen: Set<string>;
		tableMarks: ReadonlyMap<string, PortableTextTableMarkDef>;
	},
): PortableTextTableCell {
	if (typeof value !== "string" && !isRecord(value)) return fail("UNSUPPORTED_CELL_CONTENT");
	const record = asRecord(value);
	const key = reserveKey(readKey(record._key) ?? legacyKey(context.path), context.seen);
	const markDefs = normalizeMarkDefs(record.markDefs);
	const localMarks = indexMarkDefs(markDefs);
	const colspan = normalizeSpan(record.colspan);
	const rowspan = Math.min(normalizeSpan(record.rowspan), Math.max(1, context.remainingRows));
	const colwidth = normalizeColwidth(record.colwidth, colspan);
	const textAlign = normalizeAlignment(record.textAlign);
	const explicitHeader = hasOwn(record, "isHeader");
	const isHeader =
		context.promoteHeader || record.isHeader === true
			? true
			: explicitHeader && record.isHeader === false
				? false
				: undefined;
	const cell: PortableTextTableCell = {
		...safeFields(record, CELL_FIELDS),
		_type: "tableCell",
		_key: key,
		content: normalizeContent(
			value,
			record.content,
			key,
			(mark) => localMarks.get(mark) ?? context.tableMarks.get(mark),
		),
	};
	if (markDefs.length > 0) cell.markDefs = markDefs;
	if (isHeader !== undefined) cell.isHeader = isHeader;
	if (colspan > 1) cell.colspan = colspan;
	if (rowspan > 1) cell.rowspan = rowspan;
	if (colwidth) cell.colwidth = colwidth;
	if (textAlign) cell.textAlign = textAlign;
	return cell;
}

function normalizeContent(
	rawCell: unknown,
	rawContent: unknown,
	cellKey: string,
	resolveMark: (key: string) => PortableTextTableMarkDef | undefined,
): PortableTextTableSpan[] {
	const fallbackSpan = (text: string): UnknownRecord => ({
		_type: "span",
		_key: legacyKey(`${cellKey}:span:0`),
		text,
	});
	const values =
		typeof rawCell === "string"
			? [fallbackSpan(rawCell)]
			: typeof rawContent === "string"
				? [fallbackSpan(rawContent)]
				: rawContent === undefined
					? []
					: rawContent;
	if (!Array.isArray(values)) return fail("UNSUPPORTED_CELL_CONTENT");
	const content = values.map((value, index): PortableTextTableSpan => {
		if (!isRecord(value) || value._type !== "span" || typeof value.text !== "string") {
			return fail("UNSUPPORTED_CELL_CONTENT");
		}
		const marks = value.marks ?? [];
		if (!Array.isArray(marks)) return fail("UNSUPPORTED_MARK_DEFINITION");
		const normalizedMarks: string[] = [];
		for (const mark of marks) {
			if (
				typeof mark !== "string" ||
				(!DECORATOR_MARKS.has(mark) && resolveMark(mark)?._type !== "link")
			) {
				return fail("UNSUPPORTED_MARK_DEFINITION");
			}
			normalizedMarks.push(mark);
		}
		return {
			_type: "span",
			_key: readKey(value._key) ?? legacyKey(`${cellKey}:span:${index}`),
			text: value.text,
			...(normalizedMarks.length > 0 ? { marks: normalizedMarks } : {}),
		};
	});
	return content.length > 0 ? content : [emptySpan(cellKey)];
}

function normalizeMarkDefs(value: unknown): PortableTextTableMarkDef[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return fail("UNSUPPORTED_MARK_DEFINITION");
	return value.map((mark): PortableTextTableMarkDef => {
		const key = isRecord(mark) ? readKey(mark._key) : undefined;
		if (!isRecord(mark) || mark._type !== "link" || !key || typeof mark.href !== "string") {
			return fail("UNSUPPORTED_MARK_DEFINITION");
		}
		return { ...safeFields(mark), _type: "link", _key: key };
	});
}

const normalizeSpan = (value: unknown): number =>
	typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_TABLE_SPAN
		? value
		: 1;

function normalizeAlignment(value: unknown): PortableTextTableAlignment | undefined {
	return value === "left" || value === "center" || value === "right" || value === "justify"
		? value
		: undefined;
}

function normalizeColwidth(value: unknown, colspan: number): number[] | undefined {
	if (!Array.isArray(value) || value.length !== colspan || !value.every(validWidth))
		return undefined;
	return value;
}

const validWidth = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isInteger(value) &&
	value >= 0 &&
	value <= MAX_TABLE_COLUMN_WIDTH;

function assertGridBound(width: number, height: number): void {
	if (width * height > MAX_TABLE_REPAIRED_SLOTS) return fail("TABLE_TOO_LARGE");
}

function rectangleFree(
	occupied: Array<Set<number>>,
	row: number,
	column: number,
	rowspan: number,
	colspan: number,
): boolean {
	for (let y = row; y < row + rowspan; y++) {
		for (let x = column; x < column + colspan; x++) if (occupied[y]!.has(x)) return false;
	}
	return true;
}

function occupy(
	occupied: Array<Set<number>>,
	row: number,
	column: number,
	rowspan: number,
	colspan: number,
): void {
	for (let y = row; y < row + rowspan; y++) {
		for (let x = column; x < column + colspan; x++) occupied[y]?.add(x);
	}
}

function withWidths(
	cell: PortableTextTableCell,
	column: number,
	colspan: number,
	widths: Array<number | undefined>,
	hasWidths: boolean,
): PortableTextTableCell {
	const { colwidth: _colwidth, ...rest } = cell;
	if (!hasWidths) return rest;
	return {
		...rest,
		colwidth: widths.slice(column, column + colspan).map((width) => width ?? TABLE_CELL_MIN_WIDTH),
	};
}

function tableFrom(
	raw: UnknownRecord,
	key: string,
	markDefs: PortableTextTableMarkDef[],
	rows: PortableTextTableRow[],
	hasHeaderRow = false,
): PortableTextTableBlock {
	return {
		...safeFields(raw, TABLE_FIELDS),
		_type: "table",
		_key: key,
		rows,
		...(hasHeaderRow ? { hasHeaderRow: true } : {}),
		...(markDefs.length > 0 ? { markDefs } : {}),
	};
}

const emptySpan = (key: string): PortableTextTableSpan => ({
	_type: "span",
	_key: legacyKey(`${key}:span:0`),
	text: "",
});

function emptyCell(key: string, isHeader = false): PortableTextTableCell {
	return {
		_type: "tableCell",
		_key: key,
		content: [emptySpan(key)],
		...(isHeader ? { isHeader: true } : {}),
	};
}

function catchFailure<T>(
	raw: unknown,
	context: PortableTextTableContext,
	operation: () => T,
): T | ReturnType<typeof unsafeResult> {
	try {
		return operation();
	} catch (error) {
		if (error instanceof NormalizationFailure) return unsafeResult(error.reason, raw, context.path);
		throw error;
	}
}

function unsafeResult(reason: UnsafePortableTextTableReason, raw: unknown, path: string) {
	return {
		ok: false as const,
		reason,
		raw,
		...(reason === "TABLE_TOO_LARGE" ? {} : { renderFallback: makeRenderFallback(raw, path) }),
	};
}

function makeRenderFallback(raw: unknown, path: string): PortableTextTableBlock | undefined {
	const record = asRecord(raw);
	const seen = new Set<string>();
	const tableKey = reserveKey(readKey(record._key) ?? legacyKey(`${path}:fallback-table`), seen);
	let remaining = MAX_TABLE_REPAIRED_SLOTS;
	const rows: PortableTextTableRow[] = [];
	for (const [rowIndex, rawRow] of (Array.isArray(record.rows) ? record.rows : []).entries()) {
		const row = asRecord(rawRow);
		const rawCells = Array.isArray(row.cells) ? row.cells : [];
		if (Math.max(rawCells.length, 1) > remaining) return undefined;
		const rowKey = reserveKey(
			readKey(row._key) ?? legacyKey(`${tableKey}:fallback-row:${rowIndex}`),
			seen,
		);
		const cells = rawCells.map((rawCell, cellIndex): PortableTextTableCell => {
			const cell = asRecord(rawCell);
			const key = reserveKey(
				readKey(cell._key) ?? legacyKey(`${rowKey}:fallback-cell:${cellIndex}`),
				seen,
			);
			return fallbackCell(rawCell, key);
		});
		if (cells.length === 0) {
			cells.push(emptyCell(reserveKey(legacyKey(`${rowKey}:empty`), seen)));
		}
		remaining -= cells.length;
		rows.push({ _type: "tableRow", _key: rowKey, cells });
	}
	if (rows.length > 0) return { _type: "table", _key: tableKey, rows };
	const rowKey = reserveKey(legacyKey(`${tableKey}:empty-row`), seen);
	return {
		_type: "table",
		_key: tableKey,
		rows: [
			{
				_type: "tableRow",
				_key: rowKey,
				cells: [emptyCell(reserveKey(legacyKey(`${tableKey}:empty-cell`), seen))],
			},
		],
	};
}

const fallbackCell = (raw: unknown, key: string): PortableTextTableCell => ({
	_type: "tableCell",
	_key: key,
	content: [{ ...emptySpan(key), text: recoverText(raw) }],
});

function recoverText(value: unknown, depth = 0): string {
	if (depth > 32) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((entry) => recoverText(entry, depth + 1)).join("");
	const record = asRecord(value);
	if (typeof record.text === "string") return record.text;
	if (typeof record.content === "string") return record.content;
	const nested = Array.isArray(record.content)
		? record.content
		: Array.isArray(record.children)
			? record.children
			: [];
	return recoverText(nested, depth + 1);
}

const indexMarkDefs = (marks: PortableTextTableMarkDef[]) =>
	new Map(marks.map((mark) => [mark._key, mark]));

function getMarkDefs(
	table: PortableTextTableMarkDef[],
	cell: PortableTextTableMarkDef[],
): PortableTextTableMarkDef[] {
	const byKey = indexMarkDefs(table);
	for (const mark of cell) byKey.set(mark._key, mark);
	return [...byKey.values()];
}

function legacyKey(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return `legacy-table-${(hash >>> 0).toString(36)}`;
}

function reserveKey(base: string, seen: Set<string>): string {
	let candidate = base;
	for (let suffix = 1; seen.has(candidate); suffix++) candidate = `${base}-${suffix}`;
	seen.add(candidate);
	return candidate;
}

const pmAttrs = (record: UnknownRecord, fields: Set<string>): UnknownRecord => ({
	emdashKey: record._key,
	emdashData: safeFields(record, fields),
});

function safeFields(value: unknown, excluded = new Set<string>()): UnknownRecord {
	if (!isRecord(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter(
			([key]) =>
				!excluded.has(key) &&
				key !== "__proto__" &&
				key !== "prototype" &&
				key !== "constructor" &&
				!DOM_FIELD.test(key),
		),
	);
}

const isRecord = (value: unknown): value is UnknownRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const asRecord = (value: unknown): UnknownRecord => (isRecord(value) ? value : {});
const readKey = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;
const hasOwn = (record: UnknownRecord, key: string): boolean => Object.hasOwn(record, key);
const isProseMirrorNode = (value: unknown): value is PortableTextTableProseMirrorNode =>
	isRecord(value) && typeof value.type === "string";
