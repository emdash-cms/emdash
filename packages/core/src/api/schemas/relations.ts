import { z } from "zod";

const slugPattern = /^[a-z][a-z0-9_]*$/;
const collectionSlug = z
	.string()
	.min(1)
	.max(63)
	.regex(slugPattern, "Invalid collection slug format");

export const createRelationBody = z
	.object({
		name: z
			.string()
			.min(1)
			.max(63)
			.regex(slugPattern, "Name must be lowercase alphanumeric with underscores"),
		parentCollection: collectionSlug.optional(),
		childCollection: collectionSlug.optional(),
		parentLabel: z.string().min(1).max(200),
		childLabel: z.string().min(1).max(200),
		locale: z.string().min(1).optional(),
		translationOf: z.string().min(1).optional(),
	})
	// A translation inherits its structural fields (name, parentCollection,
	// childCollection) from the source relation, so the handler ignores any
	// collections supplied alongside `translationOf`. Require them only when
	// minting a base relation, so callers aren't forced to pass discarded values.
	.refine(
		(body) =>
			body.translationOf !== undefined ||
			(body.parentCollection !== undefined && body.childCollection !== undefined),
		{ message: "parentCollection and childCollection are required unless translationOf is set" },
	)
	.meta({ id: "CreateRelationBody" });

export const updateRelationBody = z
	.object({
		parentLabel: z.string().min(1).max(200).optional(),
		childLabel: z.string().min(1).max(200).optional(),
	})
	// Reject empty payloads: an update touching no field is a client mistake, not
	// a successful no-op. Without this, `{}` validates and the handler returns 200
	// with the unchanged row, so a typo'd payload looks like it landed.
	.refine((body) => body.parentLabel !== undefined || body.childLabel !== undefined, {
		message: "At least one of parentLabel or childLabel is required",
	})
	.meta({ id: "UpdateRelationBody" });

export const setReferenceChildrenBody = z
	.object({ childIds: z.array(z.string().min(1)).max(1000) })
	.meta({ id: "SetReferenceChildrenBody" });

export const relationDefSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		parentCollection: z.string(),
		childCollection: z.string(),
		parentLabel: z.string(),
		childLabel: z.string(),
		locale: z.string(),
		translationGroup: z.string(),
	})
	.meta({ id: "RelationDef" });

export const relationListResponseSchema = z
	.object({ relations: z.array(relationDefSchema) })
	.meta({ id: "RelationListResponse" });

export const relationResponseSchema = z
	.object({ relation: relationDefSchema })
	.meta({ id: "RelationResponse" });

export const relationTranslationsSchema = z
	.object({
		translationGroup: z.string(),
		translations: z.array(
			z.object({
				id: z.string(),
				name: z.string(),
				locale: z.string(),
				parentLabel: z.string(),
				childLabel: z.string(),
			}),
		),
	})
	.meta({ id: "RelationTranslations" });

export const entryRefSchema = z
	.object({
		id: z.string(),
		slug: z.string().nullable(),
		collection: z.string(),
		// The actual locale of the resolved variant. When no variant matches the
		// requesting entry's locale, the ref falls back to another locale's row;
		// this field makes that substitution explicit instead of silently
		// presenting a wrong-locale entry under the requested context.
		locale: z.string().nullable(),
		sortOrder: z.number().int().optional(),
	})
	.meta({ id: "ReferenceEntryRef" });

export const referenceChildrenResponseSchema = z
	.object({ children: z.array(entryRefSchema), nextCursor: z.string().optional() })
	.meta({ id: "ReferenceChildrenResponse" });

export const referenceParentsResponseSchema = z
	.object({ parents: z.array(entryRefSchema), nextCursor: z.string().optional() })
	.meta({ id: "ReferenceParentsResponse" });
