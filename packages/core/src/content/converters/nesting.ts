/**
 * Nesting block helpers
 *
 * Shared defaults and normalization for the `nestingBlock` layout container,
 * used by the PT to/from PM converters and the site renderer so a block that was
 * hand-authored or imported with missing/invalid layout fields still renders
 * predictably.
 */

import type { NestingAlign, NestingGap, NestingLayout } from "./types.js";

export const NESTING_LAYOUTS: readonly NestingLayout[] = ["grid", "flex"];
export const NESTING_GAPS: readonly NestingGap[] = ["none", "sm", "md", "lg"];
export const NESTING_ALIGNS: readonly NestingAlign[] = ["start", "center", "end", "stretch"];

/** Bounds for the grid column count. */
export const NESTING_MIN_COLUMNS = 1;
export const NESTING_MAX_COLUMNS = 6;

export interface NestingAttrs {
	layout: NestingLayout;
	columns: number;
	gap: NestingGap;
	align: NestingAlign;
}

export const NESTING_DEFAULTS: NestingAttrs = {
	layout: "grid",
	columns: 2,
	gap: "md",
	align: "start",
};

function coerceEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return allowed.find((candidate) => candidate === value) ?? fallback;
}

function coerceColumns(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return NESTING_DEFAULTS.columns;
	return Math.min(NESTING_MAX_COLUMNS, Math.max(NESTING_MIN_COLUMNS, Math.round(n)));
}

/** Coerce arbitrary layout fields into a valid, complete `NestingAttrs`. */
export function normalizeNestingAttrs(
	source: Partial<Record<keyof NestingAttrs, unknown>>,
): NestingAttrs {
	return {
		layout: coerceEnum(source.layout, NESTING_LAYOUTS, NESTING_DEFAULTS.layout),
		columns: coerceColumns(source.columns),
		gap: coerceEnum(source.gap, NESTING_GAPS, NESTING_DEFAULTS.gap),
		align: coerceEnum(source.align, NESTING_ALIGNS, NESTING_DEFAULTS.align),
	};
}
