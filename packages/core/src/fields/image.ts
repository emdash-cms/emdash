import { z } from "astro/zod";

import type { FieldDefinition, ImageValue } from "./types.js";

const imageSchema = z.object({
	id: z.string(),
	src: z.string().optional(),
	alt: z.string().optional(),
	width: z.number().optional(),
	height: z.number().optional(),
	filename: z.string().optional(),
	mimeType: z.string().optional(),
	blurhash: z.string().optional(),
	dominantColor: z.string().optional(),
	provider: z.string().optional(),
	previewUrl: z.string().optional(),
	meta: z.record(z.string(), z.unknown()).optional(),
});

export interface ImageOptions {
	required?: boolean;
	maxSize?: number; // in bytes
	allowedTypes?: string[]; // MIME types — exact or prefix
}

export function image(options: ImageOptions = {}): FieldDefinition<ImageValue | undefined> {
	const validation =
		options.allowedTypes && options.allowedTypes.length > 0
			? { allowedMimeTypes: [...options.allowedTypes] }
			: undefined;

	return {
		type: "image",
		columnType: "TEXT",
		schema: options.required === false ? imageSchema.optional() : imageSchema,
		options,
		ui: {
			widget: "image",
		},
		validation,
	};
}
