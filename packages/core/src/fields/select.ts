import { z } from "astro/zod";

import type { FieldDefinition, FieldUIHints } from "./types.js";

export interface SelectOptions<T extends readonly [string, ...string[]]> {
	options: T;
	required?: boolean;
	default?: T[number];
	placeholder?: string;
	helpText?: string;
}

/**
 * Select field - single choice from predefined options
 */
export function select<T extends readonly [string, ...string[]]>(
	selectOptions: SelectOptions<T>,
): FieldDefinition<T[number]> {
	const enumSchema = z.enum(selectOptions.options);

	// Apply default first, then optional
	let schema: z.ZodType;
	if (selectOptions.default !== undefined) {
		schema = enumSchema.default(selectOptions.default);
	} else if (!selectOptions.required) {
		// Only make it optional if no default is provided
		schema = enumSchema.optional();
	} else {
		schema = enumSchema;
	}

	const ui: FieldUIHints = {
		widget: "select",
		placeholder: selectOptions.placeholder,
		helpText: selectOptions.helpText,
		options: selectOptions.options,
	};

	return {
		type: "select",
		columnType: "TEXT",
		schema,
		options: selectOptions,
		ui,
	};
}
