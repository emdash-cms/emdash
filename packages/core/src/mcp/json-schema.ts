import { z } from "zod";

import type { ManifestJsonObjectSchema } from "../plugins/types.js";

type ZodJsonObjectSchema = z.core.JSONSchema.ObjectSchema;

export function jsonSchemaObjectToZod(
	schema: ManifestJsonObjectSchema,
): z.ZodType<Record<string, unknown>> {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- manifest validation constrains input schemas to object roots.
	return z.fromJSONSchema(schema as unknown as ZodJsonObjectSchema) as z.ZodType<
		Record<string, unknown>
	>;
}
