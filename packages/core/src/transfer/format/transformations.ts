/**
 * Declared transformations: every way the target state may legitimately
 * differ from the package's records.
 *
 * Two families exist:
 * - Export transformations are applied by the exporter and declared in
 *   `manifest.transformations` (the package already reflects them).
 * - Import transformations are decided during analysis, declared in the plan
 *   (and therefore covered by the plan digest), applied by the importer, and
 *   predicted by verification with {@link applyTransformations}.
 *
 * A plan lists the package's export transformations ahead of its import
 * transformations, so it declares every difference from the origin site.
 * Plan warnings never repeat a transformation.
 *
 * Storage-key placeholders are not a transformation: verification converts
 * target keys back to placeholders with `rewriteMediaRefs(…, { mode: "verify" })`.
 */

import { z } from "zod";

import type { SitePackageRecord } from "./kinds.js";
import { portableIdSchema, RECORD_KINDS } from "./kinds.js";

export const EXPORT_TRANSFORMATION_CODES = [
	"soft_orphan_dropped",
	"avatar_nulled",
	"redirect_duplicate_dropped",
	"media_not_ready_dropped",
	"media_url_relativized",
	"orphan_dropped",
	"orphan_reference_nulled",
	"media_ref_unlinked",
	"unknown_storage_key",
] as const;

export type ExportTransformationCode = (typeof EXPORT_TRANSFORMATION_CODES)[number];

export const IMPORT_TRANSFORMATION_CODES = [
	"principal_mapped",
	"principal_unmapped",
	"seeded_scaffold_removed",
	"redirect_loop_disabled",
	"search_unsupported",
	"float4_rounded",
	"locale_recased",
] as const;

export type ImportTransformationCode = (typeof IMPORT_TRANSFORMATION_CODES)[number];

const recordKindSchema = z.enum(RECORD_KINDS);
const count = z.number().int().nonnegative();
const MAX_LISTED_IDS = 10_000;
const MAX_LISTED_LOCALES = 1000;
const localeSchema = z.string().min(1).max(64);

/**
 * Declared in `manifest.transformations`, sorted by `(code, kind)`.
 * `unknown_storage_key` counts records that refer to a media file URL or
 * storage key the origin media table does not know; those references are
 * exported unchanged and will not resolve on the target.
 */
export const exportTransformationSchema = z.strictObject({
	code: z.enum(EXPORT_TRANSFORMATION_CODES),
	kind: recordKindSchema,
	count,
});

export type ExportTransformation = z.infer<typeof exportTransformationSchema>;

export const importTransformationSchema = z.discriminatedUnion("code", [
	/** Principal references rewritten to target users per `decisions.principalMappings`. */
	z.strictObject({ code: z.literal("principal_mapped"), count }),
	/** Principal references removed (mapping is null or absent). */
	z.strictObject({ code: z.literal("principal_unmapped"), count }),
	/** Seeded target scaffold deleted before the schema stage. */
	z.strictObject({
		code: z.literal("seeded_scaffold_removed"),
		count,
		items: z
			.array(z.strictObject({ type: z.string().max(64), id: portableIdSchema }))
			.max(MAX_LISTED_IDS),
	}),
	/** Redirects that form a loop are imported disabled. */
	z.strictObject({
		code: z.literal("redirect_loop_disabled"),
		kind: z.literal("redirect"),
		ids: z.array(portableIdSchema).max(MAX_LISTED_IDS),
	}),
	/** Full-text search cannot be enabled on the target; `searchConfig.enabled` becomes false. */
	z.strictObject({
		code: z.literal("search_unsupported"),
		kind: z.literal("collection"),
		ids: z.array(portableIdSchema).max(MAX_LISTED_IDS),
	}),
	/** The target stores REAL columns as float4; values are rounded with `Math.fround`. */
	z.strictObject({ code: z.literal("float4_rounded"), count }),
	/** Locales written with the target's casing (`pt-br` → `pt-BR`). */
	z.strictObject({
		code: z.literal("locale_recased"),
		locales: z
			.array(z.strictObject({ from: localeSchema, to: localeSchema }))
			.max(MAX_LISTED_LOCALES),
	}),
]);

export type ImportTransformation = z.infer<typeof importTransformationSchema>;

export const planTransformationSchema = z.union([
	exportTransformationSchema,
	importTransformationSchema,
]);

export type PlanTransformation = z.infer<typeof planTransformationSchema>;

export interface TransformationPlan {
	transformations: readonly PlanTransformation[];
	decisions: { principalMappings: Readonly<Record<string, string | null>> };
}

export type FieldColumnType = "TEXT" | "REAL" | "INTEGER" | "JSON";

export interface TransformationContext {
	/** Column type of every entry field, by collection slug then field slug (from package `field` records). */
	fieldColumnTypes: ReadonlyMap<string, ReadonlyMap<string, FieldColumnType>>;
}

interface CompiledTransformations {
	principalMappings: Readonly<Record<string, string | null>>;
	disabledRedirects: ReadonlySet<string>;
	searchDisabled: ReadonlySet<string>;
	float4: boolean;
	locales: ReadonlyMap<string, string>;
	fieldColumnTypes: TransformationContext["fieldColumnTypes"];
}

const compiled = new WeakMap<TransformationPlan, CompiledTransformations>();

function compile(
	plan: TransformationPlan,
	context: TransformationContext,
): CompiledTransformations {
	const cached = compiled.get(plan);
	if (cached && cached.fieldColumnTypes === context.fieldColumnTypes) return cached;
	const disabledRedirects = new Set<string>();
	const searchDisabled = new Set<string>();
	const locales = new Map<string, string>();
	let float4 = false;
	for (const transformation of plan.transformations) {
		switch (transformation.code) {
			case "redirect_loop_disabled":
				for (const id of transformation.ids) disabledRedirects.add(id);
				break;
			case "search_unsupported":
				for (const id of transformation.ids) searchDisabled.add(id);
				break;
			case "float4_rounded":
				float4 = true;
				break;
			case "locale_recased":
				for (const { from, to } of transformation.locales) locales.set(from, to);
				break;
			default:
				break;
		}
	}
	const result: CompiledTransformations = {
		principalMappings: plan.decisions.principalMappings,
		disabledRedirects,
		searchDisabled,
		float4,
		locales,
		fieldColumnTypes: context.fieldColumnTypes,
	};
	compiled.set(plan, result);
	return result;
}

function mapPrincipal(
	record: Record<string, unknown>,
	property: string,
	mappings: Readonly<Record<string, string | null>>,
): void {
	const principal = record[property];
	if (typeof principal !== "string") return;
	const target = Object.hasOwn(mappings, principal) ? mappings[principal] : null;
	if (target === null || target === undefined) delete record[property];
	else record[property] = target;
}

function fround(value: unknown): unknown {
	return typeof value === "number" ? Math.fround(value) : value;
}

/**
 * Predict the target form of a package record: the record as the exporter's
 * reader would produce it from the target, minus storage-key placeholder
 * resolution. Returns a new object; never mutates `record`. `principal`
 * records are returned unchanged (they are never written to the target).
 */
export function applyTransformations<R extends SitePackageRecord>(
	record: R,
	plan: TransformationPlan,
	context: TransformationContext,
): R {
	const rules = compile(plan, context);
	const next: Record<string, unknown> = { ...record };

	switch (record.kind) {
		case "media":
			mapPrincipal(next, "authorPrincipal", rules.principalMappings);
			if (rules.float4) {
				if (next.focalX !== undefined) next.focalX = fround(next.focalX);
				if (next.focalY !== undefined) next.focalY = fround(next.focalY);
			}
			break;
		case "revision":
		case "comment":
			mapPrincipal(next, "authorPrincipal", rules.principalMappings);
			break;
		case "byline":
			mapPrincipal(next, "userPrincipal", rules.principalMappings);
			break;
		case "entry": {
			mapPrincipal(next, "authorPrincipal", rules.principalMappings);
			if (rules.float4) {
				const fields: Record<string, unknown> = { ...record.fields };
				const types = rules.fieldColumnTypes.get(record.collection);
				for (const [slug, value] of Object.entries(fields)) {
					if (types?.get(slug) === "REAL") fields[slug] = fround(value);
				}
				next.fields = fields;
			}
			break;
		}
		case "redirect":
			if (rules.disabledRedirects.has(record.id)) next.enabled = false;
			break;
		case "collection": {
			const config = record.searchConfig;
			if (
				rules.searchDisabled.has(record.id) &&
				config !== null &&
				typeof config === "object" &&
				!Array.isArray(config) &&
				config.enabled === true
			) {
				next.searchConfig = { ...config, enabled: false };
			}
			break;
		}
		default:
			break;
	}
	const recased = typeof next.locale === "string" ? rules.locales.get(next.locale) : undefined;
	if (recased !== undefined) next.locale = recased;

	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- a copy of `record` with only same-kind properties changed or removed
	return next as R;
}
