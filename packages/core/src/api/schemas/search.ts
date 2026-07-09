import { z } from "zod";

import { localeCode } from "./common.js";

// ---------------------------------------------------------------------------
// Search: Input schemas
// ---------------------------------------------------------------------------

export const searchQuery = z
	.object({
		q: z.string().min(1),
		collections: z.string().optional(),
		status: z.string().optional(),
		locale: localeCode.optional(),
		limit: z.coerce.number().int().min(1).max(100).optional(),
		cursor: z.string().optional(),
	})
	.meta({ id: "SearchQuery" });

export const searchSuggestQuery = z
	.object({
		q: z.string().min(1),
		collections: z.string().optional(),
		locale: localeCode.optional(),
		limit: z.coerce.number().int().min(1).max(20).optional(),
	})
	.meta({ id: "SearchSuggestQuery" });

export const searchRebuildBody = z
	.object({
		collection: z.string().min(1),
	})
	.meta({ id: "SearchRebuildBody" });

export const searchEnableBody = z
	.object({
		collection: z.string().min(1),
		enabled: z.boolean(),
		weights: z.record(z.string(), z.number()).optional(),
	})
	.meta({ id: "SearchEnableBody" });

// ---------------------------------------------------------------------------
// Search: Response schemas
// ---------------------------------------------------------------------------

export const searchResultSchema = z
	.object({
		collection: z.string(),
		id: z.string(),
		slug: z.string().nullable(),
		locale: z.string(),
		title: z.string().optional(),
		snippet: z.string().optional(),
		score: z.number(),
	})
	.meta({ id: "SearchResult" });

export const searchResponseSchema = z
	.object({
		items: z.array(searchResultSchema),
		nextCursor: z.string().optional(),
	})
	.meta({ id: "SearchResponse" });
