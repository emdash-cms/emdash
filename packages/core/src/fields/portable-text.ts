import { z } from "astro/zod";

import type { FieldDefinition, PortableTextBlock } from "./types.js";

/**
 * Portable Text block schema
 */
const portableTextBlockSchema: z.ZodType<PortableTextBlock> = z
	.object({
		_type: z.string(),
		_key: z.string(),
	})
	.loose();

/**
 * Portable Text field
 * Stores structured content in Portable Text format
 */
export function portableText(options?: {
	required?: boolean;
}): FieldDefinition<PortableTextBlock[] | undefined> {
	const schema = z.array(portableTextBlockSchema);

	return {
		type: "portableText",
		columnType: "JSON",
		schema: options?.required === false ? schema.optional() : schema,
		options,
		ui: {
			widget: "portableText",
		},
	};
}
