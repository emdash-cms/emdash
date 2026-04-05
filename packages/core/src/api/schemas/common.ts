import { z } from "zod";

// ---------------------------------------------------------------------------
// Role level
// ---------------------------------------------------------------------------

/** Valid role level values */
export const VALID_ROLE_LEVELS = new Set([10, 20, 30, 40, 50]);

/** Role level — coerces string/number to valid RoleLevel (10|20|30|40|50) */
export const roleLevel = z.coerce
	.number()
	.int()
	.refine((n): n is 10 | 20 | 30 | 40 | 50 => VALID_ROLE_LEVELS.has(n), {
		message: "Invalid role level. Must be 10, 20, 30, 40, or 50",
	});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** Pagination query params — cursor-based */
export const cursorPaginationQuery = z
	.object({
		cursor: z.string().optional().meta({ description: "Opaque cursor for pagination" }),
		limit: z.coerce.number().int().min(1).max(100).optional().default(50).meta({
			description: "Maximum number of items to return (1-100, default 50)",
		}),
	})
	.meta({ id: "CursorPaginationQuery" });

/** Pagination query params — offset-based */
export const offsetPaginationQuery = z
	.object({
		limit: z.coerce.number().int().min(1).max(100).optional().default(50),
		offset: z.coerce.number().int().min(0).optional().default(0),
	})
	.meta({ id: "OffsetPaginationQuery" });

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Slug pattern: lowercase letters, digits, underscores, hyphens; starts with letter */
export const slugPattern = /^[a-z][a-z0-9_-]*$/;

/** Matches http(s) scheme at start of URL */
const HTTP_SCHEME_RE = /^https?:\/\//i;

/** Validates that a URL string uses http or https scheme. Rejects javascript:/data: URI XSS vectors. */
export const httpUrl = z
	.string()
	.url()
	.refine((url) => HTTP_SCHEME_RE.test(url), "URL must use http or https");

/** BCP 47 locale code — language with optional script/region subtags (e.g. en, en-US, pt-BR, es-419, zh-Hant) */
export const localeCode = z
	.string()
	.regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i, "Invalid locale code")
	.transform((v) => v.toLowerCase());

// ---------------------------------------------------------------------------
// OpenAPI: Shared response schemas
// ---------------------------------------------------------------------------

/** Standard API error response */
export const apiErrorSchema = z
	.object({
		error: z.object({
			code: z.string().meta({ description: "Machine-readable error code", example: "NOT_FOUND" }),
			message: z.string().meta({ description: "Human-readable error message" }),
		}),
	})
	.meta({ id: "ApiError" });

/** Wrap a data schema in the standard success envelope: { data: T } */
export function successEnvelope<T extends z.ZodType>(dataSchema: T) {
	return z.object({ data: dataSchema });
}

/** Standard delete response */
export const deleteResponseSchema = z.object({ deleted: z.literal(true) }).meta({
	id: "DeleteResponse",
});

/** Standard count response */
export const countResponseSchema = z
	.object({ count: z.number().int().min(0) })
	.meta({ id: "CountResponse" });
