import { z } from "zod";

import { slugPattern } from "./common.js";

export const mediaUsageCoverageStatusSchema = z
	.enum(["complete", "never", "running", "partial", "failed", "stale", "unknown"])
	.meta({ id: "MediaUsageCoverageStatus" });

export const mediaUsageCoverageSchema = z
	.object({
		scope: z.literal("all_content_collections"),
		status: mediaUsageCoverageStatusSchema,
	})
	.meta({ id: "MediaUsageCoverage" });

export const mediaUsageSummarySchema = z
	.object({
		count: z.number().int().min(0).nullable(),
		coverage: mediaUsageCoverageSchema,
	})
	.meta({ id: "MediaUsageSummary" });

export const mediaUsageDetailsQuery = z.object({
	cursor: z.string().min(1).max(2048).optional().meta({
		description: "Opaque content-entry-group cursor",
	}),
	limit: z.coerce.number().int().min(1).max(100).optional().default(50).meta({
		description: "Maximum number of content entry groups to return (1-100, default 50)",
	}),
});

export const mediaUsageOccurrenceDetailSchema = z
	.object({
		fieldSlug: z.string(),
		fieldPath: z.string(),
		occurrenceIndex: z.number().int().min(0),
		referenceType: z.enum(["image_field", "file_field", "portable_text_image", "unknown"]),
	})
	.meta({ id: "MediaUsageOccurrenceDetail" });

export const mediaUsageSourceDetailSchema = z
	.object({
		variant: z.enum(["columns", "draft_overlay"]),
		occurrences: z.array(mediaUsageOccurrenceDetailSchema),
	})
	.meta({ id: "MediaUsageSourceDetail" });

export const mediaUsageEntryDetailSchema = z
	.object({
		collection: z.string(),
		contentId: z.string(),
		title: z.string().nullable(),
		slug: z.string().nullable(),
		locale: z.string().nullable(),
		status: z.string().nullable(),
		scheduledAt: z.string().nullable(),
		deletedAt: z.string().nullable(),
		sources: z.array(mediaUsageSourceDetailSchema),
	})
	.meta({ id: "MediaUsageEntryDetail" });

export const mediaUsageDetailsResponseSchema = z
	.object({
		items: z.array(mediaUsageEntryDetailSchema),
		nextCursor: z.string().optional(),
		coverage: mediaUsageCoverageSchema,
	})
	.meta({ id: "MediaUsageDetailsResponse" });

export const mediaUsageRepairStatusSchema = z
	.enum(["complete", "partial", "failed", "stale"])
	.meta({ id: "MediaUsageRepairStatus" });

const mediaUsageRepairCollectionBody = z
	.object({
		scope: z.literal("collection"),
		collection: z.string().min(1).max(63).regex(slugPattern, "Invalid collection slug"),
	})
	.strict();

const mediaUsageRepairAllBody = z.object({ scope: z.literal("all") }).strict();

export const mediaUsageRepairBody = z
	.discriminatedUnion("scope", [mediaUsageRepairCollectionBody, mediaUsageRepairAllBody])
	.meta({ id: "MediaUsageRepairBody" });

export const mediaUsageRepairCollectionSummarySchema = z
	.object({
		collection: z.string(),
		status: mediaUsageRepairStatusSchema,
		indexedSourceCount: z.number().int().min(0),
		failedSourceCount: z.number().int().min(0),
		skippedSourceCount: z.number().int().min(0),
		deletedSourceCount: z.number().int().min(0),
		lastErrorCode: z.string().nullable(),
		startedAt: z.string(),
		completedAt: z.string().nullable(),
	})
	.meta({ id: "MediaUsageRepairCollectionSummary" });

export const mediaUsageRepairResponseSchema = z
	.object({
		status: mediaUsageRepairStatusSchema,
		indexedSourceCount: z.number().int().min(0),
		failedSourceCount: z.number().int().min(0),
		skippedSourceCount: z.number().int().min(0),
		deletedSourceCount: z.number().int().min(0),
		collections: z.array(mediaUsageRepairCollectionSummarySchema),
	})
	.meta({ id: "MediaUsageRepairResponse" });

export type MediaUsageRepairRequest = z.infer<typeof mediaUsageRepairBody>;
export type MediaUsageRepairResponse = z.infer<typeof mediaUsageRepairResponseSchema>;
export type MediaUsageCoverageStatus = z.infer<typeof mediaUsageCoverageStatusSchema>;
export type MediaUsageCoverage = z.infer<typeof mediaUsageCoverageSchema>;
export type MediaUsageSummary = z.infer<typeof mediaUsageSummarySchema>;
export type MediaUsageOccurrenceDetail = z.infer<typeof mediaUsageOccurrenceDetailSchema>;
export type MediaUsageSourceDetail = z.infer<typeof mediaUsageSourceDetailSchema>;
export type MediaUsageEntryDetail = z.infer<typeof mediaUsageEntryDetailSchema>;
export type MediaUsageDetailsResponse = z.infer<typeof mediaUsageDetailsResponseSchema>;
