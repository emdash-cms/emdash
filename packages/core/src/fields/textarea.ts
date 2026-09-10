import { z } from "astro/zod";

import type { FieldDefinition, FieldUIHints } from "./types.js";

export interface TextareaOptions {
	required?: boolean;
	minLength?: number;
	maxLength?: number;
	rows?: number;
	placeholder?: string;
	helpText?: string;
}

/**
 * Textarea field - multi-line text input
 */
export function textarea(options: TextareaOptions = {}): FieldDefinition<string> {
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

	// Optional vs required
	const schema: z.ZodType = options.required ? stringSchema : stringSchema.optional();

	const ui: FieldUIHints = {
		widget: "textarea",
		placeholder: options.placeholder,
		helpText: options.helpText,
		rows: options.rows || 6,
	};

	return {
		type: "textarea",
		columnType: "TEXT",
		schema,
		options,
		ui,
	};
}
