/**
 * The entry's text as plain text, for copying edits a room can no longer save.
 */

import { isRecord, normalizeBlocks } from "../revision-diff/normalize.js";

interface CopiedField {
	readonly kind: string;
	readonly label?: string;
	readonly options?: unknown;
}

/** Values that aren't text a reader can use: IDs, media, switches and structured data. */
const SKIPPED_KINDS = new Set([
	"boolean",
	"image",
	"file",
	"reference",
	"json",
	"blocks",
	"repeater",
]);

/** Each field with text as its label over its value, in form order, a blank line between fields. */
export function copyEditsText(
	fields: Readonly<Record<string, CopiedField>>,
	read: (name: string) => unknown,
): string {
	const sections: string[] = [];
	for (const [name, field] of Object.entries(fields)) {
		const text = fieldText(field, read(name));
		if (text) sections.push(`${field.label ?? name}\n${text}`);
	}
	return sections.join("\n\n");
}

function fieldText(field: CopiedField, value: unknown): string {
	if (SKIPPED_KINDS.has(field.kind)) return "";
	if (field.kind === "portableText") return Array.isArray(value) ? portableText(value) : "";
	if (field.kind === "multiSelect") {
		return Array.isArray(value)
			? value
					.filter((item): item is string => typeof item === "string" && item !== "")
					.map((item) => optionLabel(field.options, item))
					.join(", ")
			: "";
	}
	if (typeof value === "string") {
		if (value.trim() === "") return "";
		return field.kind === "select" ? optionLabel(field.options, value) : value;
	}
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return "";
}

/** The label a select shows for a stored value. */
function optionLabel(options: unknown, value: string): string {
	if (!Array.isArray(options)) return value;
	for (const option of options) {
		if (isRecord(option) && option.value === value && typeof option.label === "string") {
			return option.label;
		}
	}
	return value;
}

/**
 * Text blocks one per line, list items marked and numbered as the editor shows them, and tables as
 * rows of tab-separated cells. A numbered list keeps counting across blocks between its items when
 * they share a `listId`.
 */
function portableText(blocks: readonly unknown[]): string {
	let text = "";
	let previousWasListItem = false;
	/** Numbered items seen per list and level. A list without an ID ends at any other block. */
	const counts = new Map<string, number>();
	const endUnnamedLists = (deeperThan: number) => {
		for (const key of counts.keys()) {
			if (key.startsWith("run:") && Number(key.slice(4)) > deeperThan) counts.delete(key);
		}
	};
	for (const block of normalizeBlocks(blocks)) {
		const listItem = block.kind === "text" ? block.listItem : null;
		let line = "";
		if (block.kind === "text" && listItem) {
			const level = block.level ?? 1;
			endUnnamedLists(level);
			let marker = "- ";
			if (listItem === "number") {
				const listId = isRecord(block.raw) ? block.raw.listId : undefined;
				const key = typeof listId === "string" && listId ? `id:${listId}:${level}` : `run:${level}`;
				const count = counts.get(key) ?? 0;
				counts.set(key, count + 1);
				marker = `${(block.listStart ?? 1) + count}. `;
			}
			if (block.text.trim()) line = `${"  ".repeat(level - 1)}${marker}${block.text}`;
		} else {
			endUnnamedLists(0);
			if (block.kind === "text" && block.text.trim()) line = block.text;
			else if (block.kind === "code" && block.code.trim()) line = block.code;
			else if (block.kind === "opaque" && block.type === "table") line = tableText(block.raw);
		}
		const isListItem = listItem !== null;
		if (!isListItem) previousWasListItem = false;
		if (!line) continue;
		if (text) text += isListItem && previousWasListItem ? "\n" : "\n\n";
		text += line;
		previousWasListItem = isListItem;
	}
	return text;
}

function tableText(table: unknown): string {
	if (!isRecord(table) || !Array.isArray(table.rows)) return "";
	const rows: string[] = [];
	for (const row of table.rows) {
		if (!isRecord(row) || !Array.isArray(row.cells)) continue;
		const cells = row.cells.map((cell) =>
			isRecord(cell) && Array.isArray(cell.content)
				? cell.content
						.map((span) => (isRecord(span) && typeof span.text === "string" ? span.text : ""))
						.join("")
						.replace(/[\t\n]/g, " ")
				: "",
		);
		if (cells.some((cell) => cell.trim())) rows.push(cells.join("\t"));
	}
	return rows.join("\n");
}
