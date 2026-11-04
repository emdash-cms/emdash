import { localMediaFileUrl } from "../../lib/media-utils.js";
import { isRecord, spanRuns } from "../../lib/revision-diff/normalize.js";
import type { BlockRow, TextBlock, TextRun } from "../../lib/revision-diff/types.js";

/** Data attributes for the author-coloured ring on an added or changed thing, or the dimming on a removed one. */
export function markAttributes({ ring = false, dim = false }: { ring?: boolean; dim?: boolean }) {
	return {
		...(ring ? { "data-revision-ring": "" } : {}),
		...(dim ? { "data-revision-dim": "" } : {}),
	};
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The admin URL of a stored Portable Text image or gallery image, resolved like the editor does. */
export function storedImageUrl(image: unknown): string | undefined {
	if (!isRecord(image)) return undefined;
	const asset = isRecord(image.asset) ? image.asset : {};
	const storageKey = isRecord(asset.meta) ? nonEmptyString(asset.meta.storageKey) : undefined;
	const url =
		nonEmptyString(asset.url) ??
		nonEmptyString(asset.src) ??
		(storageKey ? localMediaFileUrl(storageKey) : undefined);
	if (url) return url;
	const ref = nonEmptyString(asset._ref) ?? nonEmptyString(asset.id);
	return ref ? localMediaFileUrl(ref) : nonEmptyString(image.url);
}

export type ImageAlignment = "left" | "center" | "right" | "wide" | "full";

export interface ImageLayout {
	width?: number;
	height?: number;
	alignment?: ImageAlignment;
	title?: string;
}

const IMAGE_ALIGNMENTS = new Set<unknown>(["left", "center", "right", "wide", "full"]);

function isImageAlignment(value: unknown): value is ImageAlignment {
	return IMAGE_ALIGNMENTS.has(value);
}

/** The size and alignment the editor's image node gives a stored image block. */
export function imageLayout(image: unknown): ImageLayout {
	if (!isRecord(image)) return {};
	const asset = isRecord(image.asset) ? image.asset : {};
	const originalWidth = positiveNumber(image.width) ?? positiveNumber(asset.width);
	const originalHeight = positiveNumber(image.height) ?? positiveNumber(asset.height);
	const customWidth = positiveNumber(image.displayWidth);
	const customHeight = positiveNumber(image.displayHeight);
	const aspectRatio = originalWidth && originalHeight ? originalWidth / originalHeight : undefined;
	let width = originalWidth;
	let height = originalHeight;
	if (customWidth && customHeight) {
		width = customWidth;
		height = customHeight;
	} else if (customWidth && aspectRatio) {
		width = customWidth;
		height = Math.round(customWidth / aspectRatio);
	} else if (customHeight && aspectRatio) {
		width = Math.round(customHeight * aspectRatio);
		height = customHeight;
	}
	return {
		width,
		height,
		alignment: isImageAlignment(image.alignment) ? image.alignment : undefined,
		title: nonEmptyString(image.title),
	};
}

export interface TableCellView {
	key: string;
	header: boolean;
	colSpan?: number;
	rowSpan?: number;
	textAlign?: "left" | "center" | "right" | "justify";
	runs: TextRun[];
}

export interface TableRowView {
	key: string;
	cells: TableCellView[];
}

type CellAlignment = NonNullable<TableCellView["textAlign"]>;

const CELL_ALIGNMENTS = new Set<unknown>(["left", "center", "right", "justify"]);
const MAX_SPAN = 100;

function isCellAlignment(value: unknown): value is CellAlignment {
	return CELL_ALIGNMENTS.has(value);
}

function cellSpan(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 1
		? Math.min(value, MAX_SPAN)
		: undefined;
}

/** The rows and cells of a stored table block, or null when it isn't a table the view can draw. */
export function tableRows(raw: unknown): TableRowView[] | null {
	if (!isRecord(raw) || !Array.isArray(raw.rows) || raw.rows.length === 0) return null;
	const rows: TableRowView[] = [];
	for (const [rowIndex, row] of raw.rows.entries()) {
		if (!isRecord(row) || !Array.isArray(row.cells)) return null;
		const cells: TableCellView[] = [];
		for (const [cellIndex, cell] of row.cells.entries()) {
			if (!isRecord(cell)) return null;
			cells.push({
				key: nonEmptyString(cell._key) ?? String(cellIndex),
				header: cell.isHeader === true || (raw.hasHeaderRow === true && rowIndex === 0),
				colSpan: cellSpan(cell.colspan),
				rowSpan: cellSpan(cell.rowspan),
				textAlign: isCellAlignment(cell.textAlign) ? cell.textAlign : undefined,
				runs: spanRuns(cell.content, cell.markDefs ?? raw.markDefs) ?? [],
			});
		}
		rows.push({ key: nonEmptyString(row._key) ?? String(rowIndex), cells });
	}
	return rows;
}

export interface GalleryImageView {
	key: string;
	url: string | undefined;
	alt: string;
	caption: string;
	focalX?: number;
	focalY?: number;
}

export interface GalleryView {
	columns: number;
	images: GalleryImageView[];
}

export function galleryView(raw: unknown): GalleryView | null {
	if (!isRecord(raw) || !Array.isArray(raw.images)) return null;
	const images: GalleryImageView[] = [];
	for (const [index, image] of raw.images.entries()) {
		if (!isRecord(image)) continue;
		images.push({
			key: nonEmptyString(image._key) ?? String(index),
			url: storedImageUrl(image),
			alt: typeof image.alt === "string" ? image.alt : "",
			caption: typeof image.caption === "string" ? image.caption : "",
			focalX: typeof image.focalX === "number" ? image.focalX : undefined,
			focalY: typeof image.focalY === "number" ? image.focalY : undefined,
		});
	}
	const columns =
		typeof raw.columns === "number" && Number.isFinite(raw.columns) ? Math.max(1, raw.columns) : 3;
	return { columns, images };
}

export interface ListNode {
	ordered: boolean;
	/** The number the first item shows; lists sharing a `listId` continue each other's count. */
	start: number;
	items: ListItemNode[];
}

export interface ListItemNode {
	row: BlockRow;
	children: ListNode[];
}

export type DocumentItem =
	| { kind: "block"; row: BlockRow }
	| { kind: "list"; key: string; list: ListNode };

interface ListEntry {
	row: BlockRow;
	ordered: boolean;
	level: number;
	listId: string | undefined;
	listStart: number | null;
}

interface BuiltList extends ListNode {
	listId: string | undefined;
	listStart: number | null;
	items: BuiltListItem[];
}

interface BuiltListItem extends ListItemNode {
	children: BuiltList[];
}

function normalizeListId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const id = value.trim();
	return id.length > 0 && id.length <= 128 ? id : undefined;
}

function listEntry(row: BlockRow): ListEntry | null {
	const block: TextBlock | null = row.block.kind === "text" ? row.block : null;
	if (!block?.listItem) return null;
	const ordered = block.listItem !== "bullet";
	return {
		row,
		ordered,
		level: Math.max(1, block.level ?? 1),
		listId: ordered && isRecord(block.raw) ? normalizeListId(block.raw.listId) : undefined,
		listStart: block.listStart,
	};
}

function sameNumbering(entry: ListEntry, ordered: boolean, listId: string | undefined): boolean {
	if (entry.ordered !== ordered) return false;
	return !ordered || entry.listId === listId;
}

/** Nests list items the way the editor's Portable Text conversion does. */
function buildList(entries: readonly ListEntry[], ordered: boolean): BuiltList {
	const items: BuiltListItem[] = [];
	let index = 0;
	while (index < entries.length) {
		const entry = entries[index]!;
		index++;
		const nested: ListEntry[] = [];
		if (entry.level === 1) {
			while (index < entries.length && entries[index]!.level > 1) nested.push(entries[index++]!);
		}
		items.push({ row: entry.row, children: nestedLists(nested) });
	}
	const first = entries[0];
	return {
		ordered,
		start: 1,
		listId: first?.listId,
		listStart: first?.listStart ?? null,
		items,
	};
}

function nestedLists(nested: readonly ListEntry[]): BuiltList[] {
	if (nested.length === 0) return [];
	const minLevel = Math.min(...nested.map((entry) => entry.level));
	const lists: BuiltList[] = [];
	let index = 0;
	while (index < nested.length) {
		const anchor = nested[index]!;
		const group: ListEntry[] = [];
		do {
			group.push({ ...nested[index]!, level: nested[index]!.level - 1 });
			index++;
		} while (
			index < nested.length &&
			(nested[index]!.level > minLevel ||
				sameNumbering(nested[index]!, anchor.ordered, anchor.listId))
		);
		lists.push(buildList(group, anchor.ordered));
	}
	return lists;
}

/** Numbers ordered lists like the editor: a split list sharing a `listId` keeps counting. */
function numberLists(
	lists: readonly BuiltList[],
	scope: string,
	counts: Map<string, [number, number]>,
) {
	for (const list of lists) {
		if (list.ordered) {
			const key = list.listId ? JSON.stringify([scope, list.listId]) : null;
			const base = list.listStart ?? 1;
			const [start, count] = (key && counts.get(key)) || [base, 0];
			list.start = start + count;
			if (key) counts.set(key, [start, count + list.items.length]);
		}
		for (const item of list.items) numberLists(item.children, item.row.targetId, counts);
	}
}

/**
 * The rows to draw, in order, with list items nested into lists the way the editor nests and
 * numbers them. Removed rows only appear while changes are marked.
 */
export function documentItems(rows: readonly BlockRow[], marked: boolean): DocumentItem[] {
	const visible = marked ? rows : rows.filter((row) => row.status !== "removed");
	const items: DocumentItem[] = [];
	const lists: BuiltList[] = [];
	let index = 0;
	while (index < visible.length) {
		const row = visible[index]!;
		const first = listEntry(row);
		if (!first) {
			items.push({ kind: "block", row });
			index++;
			continue;
		}
		const run: ListEntry[] = [first];
		index++;
		while (index < visible.length) {
			const entry = listEntry(visible[index]!);
			if (!entry || (entry.level === 1 && !sameNumbering(entry, first.ordered, first.listId)))
				break;
			run.push(entry);
			index++;
		}
		const list = buildList(run, first.ordered);
		lists.push(list);
		items.push({ kind: "list", key: row.targetId, list });
	}
	numberLists(lists, "root", new Map());
	return items;
}
