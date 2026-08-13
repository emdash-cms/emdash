/**
 * Request body and query parameter parsing with Zod validation.
 *
 * All API routes should use these utilities instead of `request.json() as T`
 * or raw `url.searchParams.get()` with manual coercion.
 */

import { z } from "zod";

import { apiError } from "./error.js";

/** Maximum allowed JSON request body size (10 MB). */
const MAX_BODY_SIZE = 10 * 1024 * 1024;

/**
 * Result of parsing: either the validated data or an error Response.
 * Routes should check `if (result instanceof Response) return result;`
 */
export type ParseResult<T> = T | Response;

/**
 * Parse and validate a JSON request body against a Zod schema.
 *
 * Returns the validated data on success, or a 400 Response on failure.
 * Replaces all `(await request.json()) as T` casts.
 */
export async function parseBody<T extends z.ZodType>(
	request: Request,
	schema: T,
): Promise<ParseResult<z.infer<T>>> {
	// Best-effort size check via Content-Length (can be absent with chunked encoding)
	const contentLength = request.headers.get("Content-Length");
	if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
		return apiError("PAYLOAD_TOO_LARGE", "Request body too large", 413);
	}

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
	}

	return validate(schema, raw);
}

/**
 * Parse and validate an optional JSON request body.
 *
 * Returns `defaultValue` if the body is empty, or the validated data if present.
 * For endpoints where the body is optional (e.g., preview-url, confirm).
 */
export async function parseOptionalBody<T extends z.ZodType>(
	request: Request,
	schema: T,
	defaultValue: z.infer<T>,
): Promise<ParseResult<z.infer<T>>> {
	// Best-effort size check via Content-Length (can be absent with chunked encoding)
	const contentLength = request.headers.get("Content-Length");
	if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
		return apiError("PAYLOAD_TOO_LARGE", "Request body too large", 413);
	}

	let text: string;
	try {
		text = await request.text();
	} catch {
		return defaultValue;
	}

	if (!text.trim()) {
		return defaultValue;
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
	}

	return validate(schema, raw);
}

/**
 * Parse and validate URL search params against a Zod schema.
 *
 * Converts searchParams to a plain object before validation.
 * Zod coercion handles string -> number/boolean conversion.
 * Replaces manual `url.searchParams.get()` + `parseInt()` patterns.
 */
export function parseQuery<T extends z.ZodType>(url: URL, schema: T): ParseResult<z.infer<T>> {
	const raw: Record<string, string> = {};
	for (const [key, value] of url.searchParams) {
		raw[key] = value;
	}
	return validate(schema, raw);
}

/**
 * Validate raw data against a schema. Returns data or error Response.
 */
function validate<T extends z.ZodType>(schema: T, data: unknown): ParseResult<z.infer<T>> {
	const result = schema.safeParse(data);

	if (result.success) {
		return result.data;
	}

	// Format Zod errors into a readable structure
	const issues = result.error.issues.map((issue: z.ZodIssue) => ({
		path: issue.path.join("."),
		message: issue.message,
	}));

	return apiError("VALIDATION_ERROR", "Invalid request data", 400, { issues });
}

/**
 * Type guard to check if a ParseResult is an error Response.
 * Usage: `if (isParseError(result)) return result;`
 */
export function isParseError<T>(result: ParseResult<T>): result is Response {
	return result instanceof Response;
}
