import { z } from "astro/zod";

import type { FieldDefinition, FieldUIHints } from "./types.js";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface DateOptions {
	required?: boolean;
	min?: string | Date;
	max?: string | Date;
	helpText?: string;
}

function toDateOnly(value: string | Date): string {
	return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function isValidDateOnly(value: string): boolean {
	if (!DATE_ONLY_PATTERN.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Date field - date picker without a time component.
 */
export function date(options: DateOptions = {}): FieldDefinition<string> {
	const min = options.min ? toDateOnly(options.min) : undefined;
	const max = options.max ? toDateOnly(options.max) : undefined;
	let dateSchema = z
		.string()
		.regex(DATE_ONLY_PATTERN, "Must be a date in YYYY-MM-DD format")
		.refine(isValidDateOnly, "Invalid date");

	if (min !== undefined) {
		dateSchema = dateSchema.refine((value) => value >= min, "Date is too early");
	}

	if (max !== undefined) {
		dateSchema = dateSchema.refine((value) => value <= max, "Date is too late");
	}

	const markedSchema = dateSchema as z.ZodTypeAny & { isDateOnly?: true };
	markedSchema.isDateOnly = true;

	const schema: z.ZodTypeAny = options.required ? markedSchema : markedSchema.optional();

	const ui: FieldUIHints = {
		widget: "date",
		helpText: options.helpText,
		min,
		max,
	};

	return {
		type: "date",
		columnType: "TEXT",
		schema,
		options,
		ui,
	};
}
