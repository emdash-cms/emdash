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
		url: z.string(),
		filename: z.string(),
		mimeType: z.string(),
		size: z.number(),
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
