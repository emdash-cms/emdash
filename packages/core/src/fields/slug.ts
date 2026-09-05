import { z } from "astro/zod";

import type { FieldDefinition, FieldUIHints } from "./types.js";

export interface SlugOptions {
	required?: boolean;
	from?: string; // Field name to generate slug from
	pattern?: RegExp;
	helpText?: string;
}

// Default slug pattern: lowercase alphanumeric + hyphens
const DEFAULT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Slug field - URL-safe identifier
 */
export function slug(options: SlugOptions = {}): FieldDefinition<string> {
	const pattern = options.pattern || DEFAULT_SLUG_PATTERN;
	const stringSchema = z.string().regex(pattern, "Invalid slug format");

	// Optional vs required
	const schema: z.ZodType = options.required ? stringSchema : stringSchema.optional();

	const ui: FieldUIHints = {
		widget: "slug",
		helpText: options.helpText || "URL-safe identifier (lowercase, hyphens only)",
		from: options.from,
	};

	return {
		type: "slug",
		columnType: "TEXT",
		schema,
		options,
		ui,
	};
}
