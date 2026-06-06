import type { z } from "astro/zod";

import type { FieldValidation } from "../schema/types.js";

/**
 * SQLite column types that map from field types
 */
export type ColumnType = "TEXT" | "REAL" | "INTEGER" | "JSON";

/**
 * Base field definition
 *
 * Note: schema uses z.ZodTypeAny to accommodate optional/default wrappers
 */
export interface FieldDefinition<_T = unknown> {
	type: string;
	/**
	 * The SQLite column type to use when storing this field
	 */
	columnType: ColumnType;
	schema: z.ZodTypeAny;
	options?: unknown;
	ui?: FieldUIHints;
	validation?: FieldValidation;
}

/**
 * UI hints for admin rendering
 */
export interface FieldUIHints {
	widget?: string;
	placeholder?: string;
	helpText?: string;
	rows?: number; // For textarea
	min?: number | string;
	max?: number | string;
	[key: string]: unknown;
}

/**
 * Portable Text block structure
 */
export interface PortableTextBlock {
	_type: string;
	_key: string;
	[key: string]: unknown;
}

// Re-export MediaValue from media/types.ts (canonical location)
export type { MediaValue } from "../media/types.js";
import type { MediaValue } from "../media/types.js";

/**
 * @deprecated Use MediaValue instead. ImageValue is an alias for backwards compatibility.
 */
export type ImageValue = MediaValue;

/**
 * File field value
 */
export interface FileValue {
	id: string;
	url: string;
	filename: string;
	mimeType: string;
	size: number;
}
