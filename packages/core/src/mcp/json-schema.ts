import { z } from "zod";

const fallbackSchema = z.record(z.string(), z.unknown());

export function safeJsonSchemaToZod(
	schema: Record<string, unknown>,
	onError?: (error: unknown) => void,
): z.ZodType {
	try {
		return z.fromJSONSchema(schema);
	} catch (error) {
		onError?.(error);
		return fallbackSchema;
	}
}
