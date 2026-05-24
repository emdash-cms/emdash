import { z } from "zod";

import { cursorPaginationQuery } from "./common.js";

// ---------------------------------------------------------------------------
// Media: Input schemas
// ---------------------------------------------------------------------------

/**
 * Accepts a comma-separated string (from URL query params) or an array of
 * strings (from JSON body or programmatic use) and normalises to string[].
 */
const mimeTypeFilter = z
	.union([z.string(), z.array(z.string())])
	.transform((v) => {
		const arr = Array.isArray(v) ? v : v.split(",");
		return arr.map((s) => s.trim()).filter((s) => s.length > 0);
	})
	.optional();

export const mediaListQuery = cursorPaginationQuery
	.extend({
		mimeType: mimeTypeFilter,
	})
	.meta({ id: "MediaListQuery" });

export const mediaUpdateBody = z
	.object({
		alt: z.string().optional(),
		caption: z.string().optional(),
		width: z.number().int().positive().optional(),
		height: z.number().int().positive().optional(),
	})
	.meta({ id: "MediaUpdateBody" });

/** Default maximum allowed file upload size (50 MB). */
export const DEFAULT_MAX_UPLOAD_SIZE = 50 * 1024 * 1024;

export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${Math.floor(bytes / 1024)}KB`;
	return `${Math.floor(bytes / 1024 / 1024)}MB`;
}

// Matches a full MIME type (type/subtype) with an optional semicolon-delimited
// parameter section. Forbids CR/LF to prevent header injection.
const CONTENT_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_+\-.]*\/[a-z0-9!#$&^_+\-.]+(\s*;[^\r\n]*)?$/i;

export function mediaUploadUrlBody(maxSize: number) {
	if (!Number.isFinite(maxSize) || maxSize <= 0) {
		throw new Error(`EmDash: maxUploadSize must be a positive finite number, got ${maxSize}`);
	}
	return z
		.object({
			filename: z.string().min(1, "filename is required"),
			contentType: z
				.string()
				.min(1, "contentType is required")
				.regex(CONTENT_TYPE_RE, "Invalid content type"),
			size: z
				.number()
				.int()
				.positive()
				.max(maxSize, `File size must not exceed ${formatFileSize(maxSize)}`),
			contentHash: z.string().optional(),
			fieldId: z.string().optional(),
		})
		.meta({ id: "MediaUploadUrlBody" });
}

export const mediaConfirmBody = z
	.object({
		size: z.number().int().positive().optional(),
		width: z.number().int().positive().optional(),
		height: z.number().int().positive().optional(),
	})
	.meta({ id: "MediaConfirmBody" });

export const mediaProviderListQuery = cursorPaginationQuery
	.extend({
		query: z.string().optional(),
		mimeType: mimeTypeFilter,
	})
	.meta({ id: "MediaProviderListQuery" });

// ---------------------------------------------------------------------------
// Media: Response schemas
// ---------------------------------------------------------------------------

const mediaStatusSchema = z.enum(["pending", "ready", "failed"]);

export const mediaItemSchema = z
	.object({
		id: z.string(),
		filename: z.string(),
		mimeType: z.string(),
		size: z.number().nullable(),
		width: z.number().nullable(),
		height: z.number().nullable(),
		alt: z.string().nullable(),
		caption: z.string().nullable(),
		storageKey: z.string(),
		status: mediaStatusSchema,
		contentHash: z.string().nullable(),
		blurhash: z.string().nullable(),
		dominantColor: z.string().nullable(),
		createdAt: z.string(),
		authorId: z.string().nullable(),
	})
	.meta({ id: "MediaItem" });

export const mediaResponseSchema = z
	.object({ item: mediaItemSchema })
	.meta({ id: "MediaResponse" });

export const mediaListResponseSchema = z
	.object({
		items: z.array(mediaItemSchema),
		nextCursor: z.string().optional(),
	})
	.meta({ id: "MediaListResponse" });

export const mediaUploadUrlResponseSchema = z
	.object({
		uploadUrl: z.string(),
		method: z.literal("PUT"),
		headers: z.record(z.string(), z.string()),
		mediaId: z.string(),
		storageKey: z.string(),
		expiresAt: z.string(),
	})
	.meta({ id: "MediaUploadUrlResponse" });

export const mediaExistingResponseSchema = z
	.object({
		existing: z.literal(true),
		mediaId: z.string(),
		storageKey: z.string(),
		url: z.string(),
	})
	.meta({ id: "MediaExistingResponse" });

export const mediaConfirmResponseSchema = z
	.object({
		item: mediaItemSchema.extend({ url: z.string() }),
	})
	.meta({ id: "MediaConfirmResponse" });
