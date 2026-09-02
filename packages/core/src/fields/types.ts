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
 * Persisted image field value: the media item shown by default, plus an
 * optional counterpart for dark color schemes.
 */
export interface ImageValue extends MediaValue {
	/** Media item shown instead of the primary one when the page renders in a dark color scheme. */
	darkVariant?: MediaValue;
}

/**
 * Persisted file field value.
 *
 * File values are references with cached metadata, not implicitly hydrated
 * media records. Use the media provider API when current metadata is needed.
 */
export interface FileValue {
	id: string;
	/** Legacy cached URL. Provider-backed values commonly omit this. */
	url?: string;
	/** Direct URL used by external media providers. */
	src?: string;
	/** Cached original filename, when available. */
	filename?: string;
	/** Cached MIME type, when available. */
	mimeType?: string;
	/** Cached file size in bytes, when persisted with the value. */
	size?: number;
	/** Media provider ID. Defaults to `local` when omitted. */
	provider?: string;
	/** Provider-specific data needed to resolve or render the file. */
	meta?: Record<string, unknown>;
}
