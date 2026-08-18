import { z } from "astro/zod";

import type { FieldDefinition, FieldUIHints, FileValue } from "./types.js";

export interface FileOptions {
	required?: boolean;
	maxSize?: number; // In bytes
	allowedTypes?: string[]; // MIME types — exact (image/png) or prefix (image/)
	helpText?: string;
}

export function file(options: FileOptions = {}): FieldDefinition<FileValue> {
	const fileObjSchema = z.object({
		id: z.string(),
		url: z.string().optional(),
		src: z.string().optional(),
		filename: z.string().optional(),
		mimeType: z.string().optional(),
		size: z.number().optional(),
		provider: z.string().optional(),
		meta: z.record(z.string(), z.unknown()).optional(),
	});

	const schema: z.ZodTypeAny = options.required ? fileObjSchema : fileObjSchema.optional();

	const ui: FieldUIHints = {
		widget: "file",
		helpText: options.helpText,
		maxSize: options.maxSize,
	};

	const validation =
		options.allowedTypes && options.allowedTypes.length > 0
			? { allowedMimeTypes: [...options.allowedTypes] }
			: undefined;

	return {
		type: "file",
		columnType: "TEXT",
		schema,
		options,
		ui,
		validation,
	};
}
