import type { SubFieldDef, GridAxisDef } from "./types";

/**
 * Normalize a value into a plain object keyed by sub-field definitions.
 * Missing declared keys get their defaultValue (or undefined). Keys present
 * on the input that aren't declared in `fields` are preserved verbatim, so
 * stored JSON round-trips cleanly when the schema evolves or partial data
 * is managed outside this widget.
 */
export function normalizeObject(value: unknown, fields: SubFieldDef[]): Record<string, unknown> {
	const source =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	const obj: Record<string, unknown> = { ...source };
	for (const field of fields) {
		if (source[field.key] === undefined) {
			obj[field.key] = field.defaultValue ?? undefined;
		}
	}
	return obj;
}

/** Normalize a value into an array. Non-arrays become empty arrays. */
export function normalizeArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/**
 * Normalize a grid value into `{ rowKey: { colKey: cellValue } }`.
 *
 * Handles two input formats:
 * - Object format: `{ jan: { leaf: true, fruit: true } }` (canonical)
 * - Array format: `{ jan: ["leaf", "fruit"] }` (legacy, e.g. harvest calendar)
 *
 * Missing rows are initialized as empty objects.
 */
export function normalizeGrid(
	value: unknown,
	rows: GridAxisDef[],
	columns: GridAxisDef[],
): Record<string, Record<string, unknown>> {
	const out: Record<string, Record<string, unknown>> = {};
	for (const row of rows) {
		out[row.key] = {};
	}

	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return out;
	}

	const source = value as Record<string, unknown>;
	for (const row of rows) {
		const rowVal = source[row.key];
		const rowOut = out[row.key]!;
		if (Array.isArray(rowVal)) {
			// Legacy array format: convert ["leaf", "fruit"] → { leaf: true, fruit: true }
			for (const code of rowVal) {
				if (typeof code === "string") {
					rowOut[code] = true;
				}
			}
		} else if (rowVal && typeof rowVal === "object") {
			// Object format: preserve all stored keys, then layer declared columns
			// over them. Unknown keys survive so cells added to the schema later
			// or managed outside this widget aren't silently dropped on save.
			const rowObj = rowVal as Record<string, unknown>;
			Object.assign(rowOut, rowObj);
			for (const col of columns) {
				if (rowObj[col.key] !== undefined) {
					rowOut[col.key] = rowObj[col.key];
				}
			}
		}
	}

	return out;
}

/** Normalize a value into a string array. Filters out non-strings. */
export function normalizeTags(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

const MUSTACHE_PATTERN = /\{\{(\w+)\}\}/g;

/**
 * Render a simple mustache-style summary template.
 * Replaces `{{key}}` with the corresponding value from `item`.
 * Non-scalar values render as empty to avoid `[object Object]` leaking into UI.
 */
export function renderSummary(template: string, item: Record<string, unknown>): string {
	return template.replace(MUSTACHE_PATTERN, (_match, key: string) => {
		const val = item[key];
		if (val === undefined || val === null) return "";
		if (typeof val === "string") return val;
		if (typeof val === "number" || typeof val === "boolean") return String(val);
		return "";
	});
}
