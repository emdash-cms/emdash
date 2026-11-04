import { z } from "astro/zod";

import type { FieldDefinition, FieldUIHints } from "./types.js";

export interface JsonOptions<T = unknown> {
	required?: boolean;
	schema?: z.ZodType<T>; // Optional custom schema for validation
	helpText?: string;
}

/**
 * JSON field - arbitrary JSON data
 */
export function json<T = unknown>(options: JsonOptions<T> = {}): FieldDefinition<T> {
	// When T = unknown (default), z.unknown() is already z.ZodType<unknown>.
	// When a custom schema is provided, it carries the correct generic.
	// The generic constraint ensures type safety for callers.
	let schema: z.ZodType = options.schema ?? z.unknown();

	// Optional vs required
	if (!options.required && !options.schema) {
		schema = z.unknown().optional();
	}

	const ui: FieldUIHints = {
		widget: "json",
		helpText: options.helpText || "JSON data",
	};

	return {
		type: "json",
		columnType: "JSON",
		schema,
		options,
		ui,
	};
}
