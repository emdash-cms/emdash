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

export const mediaUsageProgressSchema = z
	.object({
		status: z.enum(["indexing", "ready", "needs_attention"]),
		readyCollections: z.number().int().min(0),
		totalCollections: z.number().int().min(0),
	})
	.meta({ id: "MediaUsageProgress" });

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

export const mediaUsageWorkStateSchema = z
	.enum(["pending", "retry", "leased", "failed"])
	.meta({ id: "MediaUsageWorkState" });

export const mediaUsageWorkListQuery = z.object({
	collection: z.string().min(1).max(63).regex(slugPattern, "Invalid collection slug"),
	state: mediaUsageWorkStateSchema.optional(),
	cursor: z.string().min(1).max(2048).optional().meta({
		description: "Opaque work-page cursor",
	}),
	limit: z.coerce.number().int().min(1).max(100).optional().default(50).meta({
		description: "Maximum number of work items to return (1-100, default 50)",
	}),
});

export const mediaUsageWorkItemSchema = z
	.object({
		collectionId: z.string(),
		collectionSlug: z.string(),
		contentId: z.string(),
		state: mediaUsageWorkStateSchema,
		attemptCount: z.number().int().min(0),
		nextAttemptAt: z.string(),
		leaseExpiresAt: z.string().nullable(),
		lastAttemptedAt: z.string().nullable(),
		lastErrorCode: z.string().nullable(),
		updatedAt: z.string(),
	})
	.meta({ id: "MediaUsageWorkItem" });

export const mediaUsageWorkListResponseSchema = z
	.object({
		items: z.array(mediaUsageWorkItemSchema),
		nextCursor: z.string().optional(),
	})
	.meta({ id: "MediaUsageWorkListResponse" });

const boundedOpaqueMediaUsageId = z.string().min(1).max(2048);

export const mediaUsageWorkRetryBody = z
	.object({
		collectionId: boundedOpaqueMediaUsageId.meta({
			description: "Current immutable collection identity",
		}),
		contentId: boundedOpaqueMediaUsageId.meta({
			description: "Content entry identity, including a deleted entry",
		}),
	})
	.strict()
	.meta({ id: "MediaUsageWorkRetryBody" });

export const mediaUsageWorkRetryResponseSchema = z
	.object({
		changed: z.boolean(),
		item: mediaUsageWorkItemSchema,
	})
	.meta({ id: "MediaUsageWorkRetryResponse" });

export const mediaUsageWorkRetryConflictSchema = z.object({
	success: z.literal(false),
	error: z.discriminatedUnion("code", [
		z.object({
			code: z.literal("WORK_LEASE_ACTIVE"),
			message: z.string(),
			details: z.object({ leaseExpiresAt: z.string() }),
		}),
		z.object({
			code: z.literal("WORK_CHANGED"),
			message: z.string(),
		}),
	]),
});

export const mediaUsageActivationStateSchema = z
	.enum(["expanded", "activating", "active"])
	.meta({ id: "MediaUsageActivationState" });

export const mediaUsageActivationStatusSchema = z
	.object({
		state: mediaUsageActivationStateSchema,
		collectionCursor: z.string().nullable(),
		attemptCount: z.number().int().min(0),
		drainConfirmedAt: z.string().nullable(),
		lastAttemptedAt: z.string().nullable(),
		lastErrorCode: z.literal("MEDIA_USAGE_ACTIVATION_FAILED").nullable(),
		leaseExpiresAt: z.string().nullable(),
		activatedAt: z.string().nullable(),
		updatedAt: z.string(),
	})
	.meta({ id: "MediaUsageActivationStatus" });

export const mediaUsageActivationAdvanceBody = z
	.object({
		writersDrained: z.literal(true),
	})
	.strict()
	.meta({ id: "MediaUsageActivationAdvanceBody" });

export const mediaUsageActivationAdvanceResponseSchema = z
	.object({
		outcome: z.enum(["activating", "active"]),
		processedCollections: z.number().int().min(0).max(1),
		activation: mediaUsageActivationStatusSchema,
	})
	.meta({ id: "MediaUsageActivationAdvanceResponse" });

export const mediaUsageProgressAdvanceResponseSchema = z
	.object({
		activation: mediaUsageActivationStatusSchema,
		progress: mediaUsageProgressSchema.nullable(),
		nextRequestInMs: z.union([z.literal(0), z.literal(30_000), z.null()]),
	})
	.meta({ id: "MediaUsageProgressAdvanceResponse" });

export const mediaUsageActivationConflictSchema = z.object({
	success: z.literal(false),
	error: z.discriminatedUnion("code", [
		z.object({
			code: z.literal("MEDIA_USAGE_ACTIVATION_BUSY"),
			message: z.string(),
			details: z.object({ leaseExpiresAt: z.string() }),
		}),
		z.object({
			code: z.literal("MEDIA_USAGE_ACTIVATION_CONFLICT"),
			message: z.string(),
		}),
		z.object({
			code: z.literal("MEDIA_USAGE_ACTIVATION_VERSION_MISMATCH"),
			message: z.string(),
		}),
	]),
});

export const mediaUsageCollectionDeletionStateSchema = z
	.enum(["pending", "retry", "leased", "failed"])
	.meta({ id: "MediaUsageCollectionDeletionState" });
export const mediaUsageCollectionDeletionPhaseSchema = z
	.enum(["fence", "registry", "table", "work", "sources", "status", "finalize"])
	.meta({ id: "MediaUsageCollectionDeletionPhase" });
export const mediaUsageCollectionDeletionListQuery = z
	.object({
		state: mediaUsageCollectionDeletionStateSchema.optional().default("failed"),
		cursor: z.string().min(1).max(2048).optional(),
		limit: z.coerce.number().int().min(1).max(100).optional().default(50),
	})
	.meta({ id: "MediaUsageCollectionDeletionListQuery" });
export const mediaUsageCollectionDeletionItemSchema = z
	.object({
		collectionId: z.string(),
		collectionSlug: z.string(),
		state: mediaUsageCollectionDeletionStateSchema,
		phase: mediaUsageCollectionDeletionPhaseSchema,
		attemptCount: z.number().int().min(0),
		nextAttemptAt: z.string(),
		leaseExpiresAt: z.string().nullable(),
		lastErrorCode: z.string().nullable(),
		updatedAt: z.string(),
	})
	.meta({ id: "MediaUsageCollectionDeletionItem" });
export const mediaUsageCollectionDeletionListResponseSchema = z
	.object({
		items: z.array(mediaUsageCollectionDeletionItemSchema),
		nextCursor: z.string().optional(),
	})
	.meta({ id: "MediaUsageCollectionDeletionListResponse" });
export const mediaUsageCollectionDeletionRetryBody = z
	.object({ collectionId: boundedOpaqueMediaUsageId })
	.strict()
	.meta({ id: "MediaUsageCollectionDeletionRetryBody" });
export const mediaUsageCollectionDeletionRetryResponseSchema = z
	.object({
		changed: z.boolean(),
		item: mediaUsageCollectionDeletionItemSchema,
	})
	.meta({ id: "MediaUsageCollectionDeletionRetryResponse" });

export type MediaUsageRepairRequest = z.infer<typeof mediaUsageRepairBody>;
export type MediaUsageRepairResponse = z.infer<typeof mediaUsageRepairResponseSchema>;
export type MediaUsageProgress = z.infer<typeof mediaUsageProgressSchema>;
export type MediaUsageProgressAdvanceResponse = z.infer<
	typeof mediaUsageProgressAdvanceResponseSchema
>;
export type MediaUsageWorkListQuery = z.infer<typeof mediaUsageWorkListQuery>;
export type MediaUsageWorkItem = z.infer<typeof mediaUsageWorkItemSchema>;
export type MediaUsageWorkListResponse = z.infer<typeof mediaUsageWorkListResponseSchema>;
export type MediaUsageWorkRetryRequest = z.infer<typeof mediaUsageWorkRetryBody>;
export type MediaUsageWorkRetryResponse = z.infer<typeof mediaUsageWorkRetryResponseSchema>;
export type MediaUsageActivationStatus = z.infer<typeof mediaUsageActivationStatusSchema>;
export type MediaUsageActivationAdvanceRequest = z.infer<typeof mediaUsageActivationAdvanceBody>;
export type MediaUsageActivationAdvanceResponse = z.infer<
	typeof mediaUsageActivationAdvanceResponseSchema
>;
export type MediaUsageCollectionDeletionListQuery = z.infer<
	typeof mediaUsageCollectionDeletionListQuery
>;
export type MediaUsageCollectionDeletionListResponse = z.infer<
	typeof mediaUsageCollectionDeletionListResponseSchema
>;
export type MediaUsageCollectionDeletionRetryRequest = z.infer<
	typeof mediaUsageCollectionDeletionRetryBody
>;
export type MediaUsageCollectionDeletionRetryResponse = z.infer<
	typeof mediaUsageCollectionDeletionRetryResponseSchema
>;
export type MediaUsageCoverageStatus = z.infer<typeof mediaUsageCoverageStatusSchema>;
export type MediaUsageCoverage = z.infer<typeof mediaUsageCoverageSchema>;
export type MediaUsageSummary = z.infer<typeof mediaUsageSummarySchema>;
export type MediaUsageOccurrenceDetail = z.infer<typeof mediaUsageOccurrenceDetailSchema>;
export type MediaUsageSourceDetail = z.infer<typeof mediaUsageSourceDetailSchema>;
export type MediaUsageEntryDetail = z.infer<typeof mediaUsageEntryDetailSchema>;
export type MediaUsageDetailsResponse = z.infer<typeof mediaUsageDetailsResponseSchema>;
