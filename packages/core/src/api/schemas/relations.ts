import { z } from "zod";

const slugPattern = /^[a-z][a-z0-9_]*$/;
const collectionSlug = z
	.string()
	.min(1)
	.max(63)
	.regex(slugPattern, "Invalid collection slug format");

/** NULL means unlimited on that side. */
const roleLimit = z.number().int().positive().nullable().optional();
const roleLabelSingular = z.string().min(1).max(200).nullable().optional();

export const createRelationBody = z
	.object({
		slug: z
			.string()
			.min(1)
			.max(63)
			.regex(slugPattern, "Slug must be lowercase alphanumeric with underscores"),
		parentCollection: collectionSlug,
		childCollection: collectionSlug,
		parentLabel: z.string().min(1).max(200),
		parentLabelSingular: roleLabelSingular,
		childLabel: z.string().min(1).max(200),
		childLabelSingular: roleLabelSingular,
		maxChildrenPerParent: roleLimit,
		maxParentsPerChild: roleLimit,
	})
	.meta({ id: "CreateRelationBody" });

export const relationListQuery = z
	.object({
		collection: collectionSlug.optional().meta({
			description: "Only relations with this collection on one end",
		}),
	})
	.meta({ id: "RelationListQuery" });

export const updateRelationBody = z
	.object({
		parentLabel: z.string().min(1).max(200).optional(),
		parentLabelSingular: roleLabelSingular,
		childLabel: z.string().min(1).max(200).optional(),
		childLabelSingular: roleLabelSingular,
		maxChildrenPerParent: roleLimit,
		maxParentsPerChild: roleLimit,
	})
	// Reject empty payloads: an update touching no field is a client mistake, not
	// a successful no-op. Without this, `{}` validates and the handler returns 200
	// with the unchanged row, so a typo'd payload looks like it landed.
	.refine((body) => Object.values(body).some((value) => value !== undefined), {
		message: "At least one field is required",
	})
	.meta({ id: "UpdateRelationBody" });

export const setReferenceChildrenBody = z
	.object({ childIds: z.array(z.string().min(1)).max(1000) })
	.meta({ id: "SetReferenceChildrenBody" });

export const relationDefSchema = z
	.object({
		id: z.string(),
		slug: z.string(),
		parentCollection: z.string(),
		childCollection: z.string(),
		parentLabel: z.string(),
		parentLabelSingular: z.string().nullable(),
		childLabel: z.string(),
		childLabelSingular: z.string().nullable(),
		maxChildrenPerParent: z.number().int().nullable(),
		maxParentsPerChild: z.number().int().nullable(),
	})
	.meta({ id: "RelationDef" });

/** A relation plus what deleting it would take: the fields that view it and
 * how many links it holds. */
export const relationWithUsageSchema = relationDefSchema
	.extend({
		boundFields: z.array(
			z.object({
				collectionSlug: z.string(),
				fieldSlug: z.string(),
				side: z.enum(["parent", "child"]),
			}),
		),
		linkCount: z.number().int(),
	})
	.meta({ id: "RelationWithUsage" });

export const relationListResponseSchema = z
	.object({ relations: z.array(relationWithUsageSchema) })
	.meta({ id: "RelationListResponse" });

export const relationResponseSchema = z
	.object({ relation: relationWithUsageSchema })
	.meta({ id: "RelationResponse" });

export const entryRefSchema = z
	.object({
		id: z.string(),
		slug: z.string().nullable(),
		collection: z.string(),
		// Display label sourced from the entry's `title`, then `name`, field —
		// `null` when neither is set. Mirrors the runtime `EntryRef`.
		title: z.string().nullable(),
		// The actual locale of the resolved variant. When no variant matches the
		// requesting entry's locale, the ref falls back to another locale's row;
		// this field makes that substitution explicit instead of silently
		// presenting a wrong-locale entry under the requested context.
		locale: z.string().nullable(),
		// The translation group the ref resolved from — the locale-stable identity
		// of the referenced entry, which `id` is not.
		translationGroup: z.string().nullable(),
		sortOrder: z.number().int().optional(),
	})
	.meta({ id: "ReferenceEntryRef" });

export const referenceChildrenResponseSchema = z
	.object({ children: z.array(entryRefSchema), nextCursor: z.string().optional() })
	.meta({ id: "ReferenceChildrenResponse" });

export const referenceParentsResponseSchema = z
	.object({ parents: z.array(entryRefSchema), nextCursor: z.string().optional() })
	.meta({ id: "ReferenceParentsResponse" });
