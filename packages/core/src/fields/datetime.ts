import { z } from "astro/zod";

import type { FieldDefinition, FieldUIHints } from "./types.js";

export interface DatetimeOptions {
	required?: boolean;
	min?: Date;
	max?: Date;
	helpText?: string;
}

/**
 * Datetime field - date and time picker
 */
export function datetime(options: DatetimeOptions = {}): FieldDefinition<Date> {
	let dateSchema = z.date();

	// Apply constraints
	if (options.min !== undefined) {
		dateSchema = dateSchema.min(options.min, "Date is too early");
	}

	if (options.max !== undefined) {
		dateSchema = dateSchema.max(options.max, "Date is too late");
	}

	// Optional vs required
	const schema: z.ZodType = options.required ? dateSchema : dateSchema.optional();

	const ui: FieldUIHints = {
		widget: "datetime",
		helpText: options.helpText,
		min: options.min?.toISOString(),
		max: options.max?.toISOString(),
	};

	return {
		type: "datetime",
		columnType: "TEXT",
		schema,
		options,
		ui,
	};
}
