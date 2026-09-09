import { z } from "astro/zod";

import type { FieldDefinition, FieldUIHints } from "./types.js";

export interface BooleanOptions {
	default?: boolean;
	label?: string;
	helpText?: string;
}

/**
 * Boolean field - checkbox/toggle
 */
export function boolean(options: BooleanOptions = {}): FieldDefinition<boolean> {
	const boolSchema = z.boolean();

	// Apply default
	const schema: z.ZodType =
		options.default !== undefined ? boolSchema.default(options.default) : boolSchema;

	const ui: FieldUIHints = {
		widget: "boolean",
		label: options.label,
		helpText: options.helpText,
	};

	return {
		type: "boolean",
		columnType: "INTEGER",
		schema,
		options,
		ui,
	};
}
