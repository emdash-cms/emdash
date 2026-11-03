import { z } from "zod";

export function safeJsonSchemaToZod(
	schema: Record<string, unknown>,
	toolId: string,
	kind: "input" | "output",
): z.ZodType | undefined {
	try {
		return z.fromJSONSchema(schema);
	} catch (error) {
		console.warn(`[emdash] Invalid ${kind} schema for plugin MCP tool ${toolId}:`, error);
		return undefined;
	}
}
