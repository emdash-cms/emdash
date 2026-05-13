import { z } from "zod";

import type {
	ManifestJsonArraySchema,
	ManifestJsonBooleanSchema,
	ManifestJsonNumberSchema,
	ManifestJsonObjectSchema,
	ManifestJsonSchema,
	ManifestJsonStringSchema,
} from "../plugins/types.js";

export function jsonSchemaObjectToZod(
	schema: ManifestJsonObjectSchema,
): z.ZodType<Record<string, unknown>> {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- object roots are converted through objectSchemaToZod()
	return schemaToZod(schema) as z.ZodType<Record<string, unknown>>;
}

function schemaToZod(schema: ManifestJsonSchema): z.ZodTypeAny {
	switch (schema.type) {
		case "string":
			return stringSchemaToZod(schema);
		case "number":
		case "integer":
			return numberSchemaToZod(schema);
		case "boolean":
			return booleanSchemaToZod(schema);
		case "array":
			return arraySchemaToZod(schema);
		case "object":
			return objectSchemaToZod(schema);
	}
}

function applyCommon(schema: z.ZodTypeAny, source: ManifestJsonSchema): z.ZodTypeAny {
	let next = source.description ? schema.describe(source.description) : schema;
	if ("default" in source) {
		next = next.default(source.default);
	}
	return next;
}

function applyEnum<TValue extends string | number | boolean>(
	schema: z.ZodTypeAny,
	values: TValue[] | undefined,
): z.ZodTypeAny {
	if (!values) return schema;
	return schema.refine((value) => values.some((allowed) => Object.is(allowed, value)), {
		message: `Expected one of: ${values.join(", ")}`,
	});
}

function stringSchemaToZod(schema: ManifestJsonStringSchema): z.ZodTypeAny {
	let next = z.string();
	if (schema.minLength !== undefined) next = next.min(schema.minLength);
	if (schema.maxLength !== undefined) next = next.max(schema.maxLength);
	if (schema.pattern) next = next.regex(RegExp(schema.pattern));
	if (schema.format === "date-time") next = next.datetime();
	if (schema.format === "email") next = next.email();
	if (schema.format === "uri") next = next.url();
	if (schema.format === "uuid") next = next.uuid();
	return applyCommon(applyEnum(next, schema.enum), schema);
}

function numberSchemaToZod(schema: ManifestJsonNumberSchema): z.ZodTypeAny {
	let next = schema.type === "integer" ? z.number().int() : z.number();
	if (schema.minimum !== undefined) next = next.min(schema.minimum);
	if (schema.maximum !== undefined) next = next.max(schema.maximum);
	return applyCommon(applyEnum(next, schema.enum), schema);
}

function booleanSchemaToZod(schema: ManifestJsonBooleanSchema): z.ZodTypeAny {
	return applyCommon(applyEnum(z.boolean(), schema.enum), schema);
}

function arraySchemaToZod(schema: ManifestJsonArraySchema): z.ZodTypeAny {
	let next = z.array(schemaToZod(schema.items));
	if (schema.minItems !== undefined) next = next.min(schema.minItems);
	if (schema.maxItems !== undefined) next = next.max(schema.maxItems);
	return applyCommon(next, schema);
}

function objectSchemaToZod(schema: ManifestJsonObjectSchema): z.ZodTypeAny {
	const required = new Set(schema.required ?? []);
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
		const zodSchema = schemaToZod(propertySchema);
		shape[key] = required.has(key) ? zodSchema : zodSchema.optional();
	}

	const objectSchema = z.object(shape);
	const next =
		schema.additionalProperties === false ? objectSchema.strict() : objectSchema.passthrough();
	return applyCommon(next, schema);
}
