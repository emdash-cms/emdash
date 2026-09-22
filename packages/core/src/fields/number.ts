import { z } from "astro/zod";

import type { FieldDefinition, FieldUIHints } from "./types.js";

export interface NumberOptions {
	required?: boolean;
	min?: number;
	max?: number;
	integer?: boolean;
	placeholder?: string;
	helpText?: string;
}

/**
 * Number field - numeric input
 */
export function number(options: NumberOptions = {}): FieldDefinition<number> {
	let numberSchema = z.number();

	// Integer constraint
	if (options.integer) {
		numberSchema = numberSchema.int("Must be an integer");
	}

	// Range constraints
	if (options.min !== undefined) {
		numberSchema = numberSchema.min(options.min, `Must be at least ${options.min}`);
	}

	if (options.max !== undefined) {
		numberSchema = numberSchema.max(options.max, `Must be at most ${options.max}`);
	}

	// Optional vs required
	const schema: z.ZodType = options.required ? numberSchema : numberSchema.optional();

	const ui: FieldUIHints = {
		widget: "number",
		placeholder: options.placeholder,
		helpText: options.helpText,
		min: options.min,
		max: options.max,
	};

	return {
		type: "number",
		columnType: "REAL",
		schema,
		options,
		ui,
	};
}
