import { z } from "astro/zod";

import type { FieldDefinition, FieldUIHints } from "./types.js";

export interface TextOptions {
	required?: boolean;
	minLength?: number;
	maxLength?: number;
	pattern?: RegExp;
	placeholder?: string;
	helpText?: string;
}

/**
 * Text field - single line text input
 */
export function text(options: TextOptions = {}): FieldDefinition<string> {
	let stringSchema = z.string();

	// Apply constraints
	if (options.minLength !== undefined) {
		stringSchema = stringSchema.min(
			options.minLength,
			`Must be at least ${options.minLength} characters`,
		);
	}

	if (options.maxLength !== undefined) {
		stringSchema = stringSchema.max(
			options.maxLength,
			`Must be at most ${options.maxLength} characters`,
		);
	}

	if (options.pattern) {
		stringSchema = stringSchema.regex(options.pattern, "Invalid format");
	}

	// Optional vs required
	const schema: z.ZodType = options.required ? stringSchema : stringSchema.optional();

	const ui: FieldUIHints = {
		widget: "text",
		placeholder: options.placeholder,
		helpText: options.helpText,
	};

	return {
		type: "text",
		columnType: "TEXT",
		schema,
		options,
		ui,
	};
}
