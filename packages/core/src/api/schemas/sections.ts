import { z } from "zod";

// ---------------------------------------------------------------------------
// Sections: Input schemas
// ---------------------------------------------------------------------------

const sectionSource = z.enum(["theme", "user", "import"]);

export const sectionsListQuery = z
	.object({
		source: sectionSource.optional(),
		search: z.string().optional(),
		limit: z.coerce.number().int().min(1).max(100).optional().default(50),
		cursor: z.string().max(2048).optional(),
	})
	.meta({ id: "SectionsListQuery" });

export const createSectionBody = z
	.object({
		slug: z.string().min(1),
		title: z.string().min(1),
		description: z.string().optional(),
		keywords: z.array(z.string()).optional(),
		content: z.array(z.record(z.string(), z.unknown())),
		previewMediaId: z.string().optional(),
		source: z.enum(["user", "import"]).optional(),
		themeId: z.string().optional(),
	})
	.meta({ id: "CreateSectionBody" });

export const updateSectionBody = z
	.object({
		slug: z.string().min(1).optional(),
		title: z.string().min(1).optional(),
		description: z.string().optional(),
		keywords: z.array(z.string()).optional(),
		content: z.array(z.record(z.string(), z.unknown())).optional(),
		previewMediaId: z.string().nullish(),
	})
	.meta({ id: "UpdateSectionBody" });

// ---------------------------------------------------------------------------
// Sections: Response schemas
// ---------------------------------------------------------------------------

export const sectionSchema = z
	.object({
		id: z.string(),
		slug: z.string(),
		title: z.string(),
		description: z.string().nullable(),
		keywords: z.array(z.string()).nullable(),
		content: z.array(z.record(z.string(), z.unknown())),
		previewMediaId: z.string().nullable(),
		source: z.string(),
		themeId: z.string().nullable(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.meta({ id: "Section" });

export const sectionListResponseSchema = z
	.object({
		items: z.array(sectionSchema),
		nextCursor: z.string().optional(),
	})
	.meta({ id: "SectionListResponse" });
