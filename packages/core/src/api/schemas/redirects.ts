import { z } from "zod";

import { cursorPaginationQuery } from "./common.js";

// ---------------------------------------------------------------------------
// Redirects: Input schemas
// ---------------------------------------------------------------------------

const redirectType = z.coerce
	.number()
	.int()
	.refine((n) => [301, 302, 307, 308].includes(n), {
		message: "Redirect type must be 301, 302, 307, or 308",
	});

/** Matches CR or LF characters */
const CRLF = /[\r\n]/;

/** Path must start with / and not be protocol-relative, contain no CRLF, and no path traversal */
const urlPath = z
	.string()
	.min(1)
	.refine((s) => s.startsWith("/") && !s.startsWith("//"), {
		message: "Must be a path starting with / (no protocol-relative URLs)",
	})
	.refine((s) => !CRLF.test(s), {
		message: "URL must not contain newline characters",
	})
	.refine(
		(s) => {
			try {
				return !decodeURIComponent(s).split("/").includes("..");
			} catch {
				return false;
			}
		},
		{ message: "URL must not contain path traversal segments" },
	);

export const createRedirectBody = z
	.object({
		source: urlPath,
		destination: urlPath,
		type: redirectType.optional().default(301),
		enabled: z.boolean().optional().default(true),
		groupName: z.string().nullish(),
	})
	.meta({ id: "CreateRedirectBody" });

export const updateRedirectBody = z
	.object({
		source: urlPath.optional(),
		destination: urlPath.optional(),
		type: redirectType.optional(),
		enabled: z.boolean().optional(),
		groupName: z.string().nullish(),
	})
	.refine((o) => Object.values(o).some((v) => v !== undefined), {
		message: "At least one field must be provided",
	})
	.meta({ id: "UpdateRedirectBody" });

export const redirectsListQuery = cursorPaginationQuery
	.extend({
		search: z.string().optional(),
		group: z.string().optional(),
		enabled: z
			.enum(["true", "false"])
			.transform((v) => v === "true")
			.optional(),
		auto: z
			.enum(["true", "false"])
			.transform((v) => v === "true")
			.optional(),
	})
	.meta({ id: "RedirectsListQuery" });

// ---------------------------------------------------------------------------
// 404 Log: Input schemas
// ---------------------------------------------------------------------------

export const notFoundListQuery = cursorPaginationQuery
	.extend({
		search: z.string().optional(),
	})
	.meta({ id: "NotFoundListQuery" });

export const notFoundSummaryQuery = z.object({
	limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export const notFoundPruneBody = z
	.object({
		olderThan: z.string().datetime({ message: "olderThan must be an ISO 8601 datetime" }),
	})
	.meta({ id: "NotFoundPruneBody" });

// ---------------------------------------------------------------------------
// Redirects: Response schemas
// ---------------------------------------------------------------------------

export const redirectSchema = z
	.object({
		id: z.string(),
		source: z.string(),
		destination: z.string(),
		type: z.number().int(),
		isPattern: z.boolean(),
		enabled: z.boolean(),
		hits: z.number().int(),
		lastHitAt: z.string().nullable(),
		groupName: z.string().nullable(),
		auto: z.boolean(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.meta({ id: "Redirect" });

export const redirectListResponseSchema = z
	.object({
		items: z.array(redirectSchema),
		nextCursor: z.string().optional(),
		loopRedirectIds: z.array(z.string()).optional(),
	})
	.meta({ id: "RedirectListResponse" });

export const notFoundEntrySchema = z
	.object({
		id: z.string(),
		path: z.string(),
		referrer: z.string().nullable(),
		userAgent: z.string().nullable(),
		ip: z.string().nullable(),
		createdAt: z.string(),
	})
	.meta({ id: "NotFoundEntry" });

export const notFoundListResponseSchema = z
	.object({
		items: z.array(notFoundEntrySchema),
		nextCursor: z.string().optional(),
	})
	.meta({ id: "NotFoundListResponse" });

export const notFoundSummarySchema = z
	.object({
		path: z.string(),
		count: z.number().int(),
		lastSeen: z.string(),
		topReferrer: z.string().nullable(),
	})
	.meta({ id: "NotFoundSummary" });

export const notFoundSummaryResponseSchema = z
	.object({ items: z.array(notFoundSummarySchema) })
	.meta({ id: "NotFoundSummaryResponse" });
