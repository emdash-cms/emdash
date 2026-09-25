/**
 * Import plans, decisions, and the warning/blocker vocabulary.
 *
 * Analysis produces a {@link SiteImportPlan} with default decisions; the
 * caller may resubmit different decisions, which produces a new plan (and a
 * new plan digest). Execution requires the exact `{ packageDigest,
 * planDigest }` pair. The plan digest covers the whole plan object
 * (see `format/digest.ts`).
 */

import { z } from "zod";

import { portableIdSchema, RECORD_KINDS } from "./kinds.js";
import { planTransformationSchema } from "./transformations.js";
import { SITE_PACKAGE_FORMAT_VERSION } from "./version.js";

export const PLAN_BLOCKER_CODES = [
	"package_invalid",
	"unsupported_format",
	"unsupported_feature",
	"limit_exceeded",
	"file_missing",
	"file_mismatch",
	"record_invalid",
	"record_count_mismatch",
	"record_order_invalid",
	"duplicate_id",
	"dangling_reference",
	"reference_cycle",
	"media_ref_invalid",
	"media_blob_missing",
	"media_blob_too_large",
	"target_not_empty",
	"locale_not_configured",
	"field_type_unknown",
	"principal_conflict",
	"integer_out_of_range",
	"value_constraint_violation",
	"unique_violation",
] as const;

export type PlanBlockerCode = (typeof PLAN_BLOCKER_CODES)[number];

export const PLAN_WARNING_CODES = [
	"media_row_missing",
	"media_provider_external",
	"soft_reference_dangling",
	"redirect_loops_unchecked",
	"issues_truncated",
] as const;

export type PlanWarningCode = (typeof PLAN_WARNING_CODES)[number];

const issueDetail = z.record(
	z.string().max(64),
	z.union([z.string().max(1024), z.number(), z.boolean(), z.null()]),
);

function planIssueSchema<const Codes extends readonly [string, ...string[]]>(codes: Codes) {
	return z.strictObject({
		code: z.enum(codes),
		message: z.string().max(1024),
		kind: z.enum(RECORD_KINDS).optional(),
		id: portableIdSchema.optional(),
		count: z.number().int().nonnegative().optional(),
		detail: issueDetail.optional(),
	});
}

export const planBlockerSchema = planIssueSchema(PLAN_BLOCKER_CODES);
export const planWarningSchema = planIssueSchema(PLAN_WARNING_CODES);

export type PlanBlocker = z.infer<typeof planBlockerSchema>;
export type PlanWarning = z.infer<typeof planWarningSchema>;

export const SETTING_CHOICES = ["package", "target"] as const;

export const siteImportDecisionsSchema = z.strictObject({
	/** Origin principal id → target user id, or null to drop the reference. */
	principalMappings: z.record(portableIdSchema, portableIdSchema.nullable()),
	siteTitle: z.enum(SETTING_CHOICES),
	siteTagline: z.enum(SETTING_CHOICES),
});

export type SiteImportDecisions = z.infer<typeof siteImportDecisionsSchema>;

/** Decisions a caller may submit; omitted values keep the plan defaults. */
export const siteImportDecisionsInputSchema = z.strictObject({
	principalMappings: z.record(portableIdSchema, portableIdSchema.nullable()).optional(),
	siteTitle: z.enum(SETTING_CHOICES).optional(),
	siteTagline: z.enum(SETTING_CHOICES).optional(),
});

export type SiteImportDecisionsInput = z.infer<typeof siteImportDecisionsInputSchema>;

export const planPrincipalSchema = z.strictObject({
	id: portableIdSchema,
	displayName: z.string().max(4096),
	email: z.string().max(4096).optional(),
	/** Number of package references to this principal. */
	references: z.number().int().nonnegative(),
	/** Target user whose email matches case-insensitively, if exactly one does. */
	suggestedUserId: portableIdSchema.optional(),
});

export type PlanPrincipal = z.infer<typeof planPrincipalSchema>;

const settingValueSummary = z.strictObject({
	package: z.string().max(4096).optional(),
	target: z.string().max(4096).optional(),
});

export const siteImportPlanSchema = z.strictObject({
	formatVersion: z.literal(SITE_PACKAGE_FORMAT_VERSION),
	packageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
	origin: z.strictObject({
		siteId: portableIdSchema,
		packageId: portableIdSchema,
		createdAt: z.string().max(64),
		createdByEmDashVersion: z.string().max(128),
	}),
	target: z.strictObject({
		siteId: portableIdSchema,
		dialect: z.enum(["sqlite", "postgres"]),
		emdashVersion: z.string().max(128),
	}),
	counts: z.partialRecord(z.enum(RECORD_KINDS), z.number().int().nonnegative()),
	bytes: z.strictObject({
		records: z.number().int().nonnegative(),
		media: z.number().int().nonnegative(),
	}),
	principals: z.array(planPrincipalSchema),
	settings: z.strictObject({ title: settingValueSummary, tagline: settingValueSummary }),
	decisions: siteImportDecisionsSchema,
	transformations: z.array(planTransformationSchema),
	warnings: z.array(planWarningSchema),
	blockers: z.array(planBlockerSchema),
	estimatedSteps: z.number().int().nonnegative(),
});

export type SiteImportPlan = z.infer<typeof siteImportPlanSchema>;

/** Merge submitted decisions over a plan's defaults. Unknown principal ids are ignored. */
export function mergeDecisions(
	defaults: SiteImportDecisions,
	input: SiteImportDecisionsInput | undefined,
): SiteImportDecisions {
	if (!input) return defaults;
	const principalMappings: Record<string, string | null> = { ...defaults.principalMappings };
	for (const [principalId, userId] of Object.entries(input.principalMappings ?? {})) {
		if (Object.hasOwn(principalMappings, principalId)) principalMappings[principalId] = userId;
	}
	return {
		principalMappings,
		siteTitle: input.siteTitle ?? defaults.siteTitle,
		siteTagline: input.siteTagline ?? defaults.siteTagline,
	};
}

export function isPlanExecutable(plan: Pick<SiteImportPlan, "blockers">): boolean {
	return plan.blockers.length === 0;
}
