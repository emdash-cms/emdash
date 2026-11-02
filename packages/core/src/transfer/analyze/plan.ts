/**
 * Import plan assembly and decisions.
 *
 * A plan has decision-independent parts (counts, validation and target
 * findings, the package's export transformations, transformations the
 * target forces) and parts that follow from the decisions (principal mapping
 * transformations, principal conflict blockers). {@link applyDecisions} recomputes
 * only the latter, so resubmitting decisions never needs the package again.
 */

import type { ScaffoldItem } from "../domain.js";
import { TRANSFER_LIMITS } from "../format/limits.js";
import type { SitePackageManifest } from "../format/manifest.js";
import {
	siteImportPlanSchema,
	type PlanBlocker,
	type PlanPrincipal,
	type PlanWarning,
	type SiteImportDecisions,
	type SiteImportPlan,
} from "../format/plan.js";
import {
	EXPORT_TRANSFORMATION_CODES,
	IMPORT_TRANSFORMATION_CODES,
	type ImportTransformationCode,
	type PlanTransformation,
} from "../format/transformations.js";
import { SITE_PACKAGE_FORMAT_VERSION } from "../format/version.js";
import { MAX_LOOP_CHECKED_REDIRECTS } from "./target.js";
import type { ValidationSummary } from "./validate.js";
import type { TargetDialect } from "./values.js";

const MAX_LISTED_IDS = 10_000;
const MAX_PROVIDER_WARNINGS = 100;

/** Stages an import always runs besides its record chunks and media steps. */
const FIXED_IMPORT_STEPS = 10;

const DECISION_BLOCKER_CODES: ReadonlySet<string> = new Set(["principal_conflict"]);
const DECISION_TRANSFORMATION_CODES: ReadonlySet<string> = new Set<ImportTransformationCode>([
	"principal_mapped",
	"principal_unmapped",
]);

export interface PlanOrigin {
	siteId: string;
	packageId: string;
	createdAt: string;
	createdByEmDashVersion: string;
}

export interface PlanTarget {
	siteId: string;
	dialect: TargetDialect;
	emdashVersion: string;
}

/** Byline facts the principal-conflict check needs, by principal id. */
export interface PrincipalBylines {
	/** Locales in which each principal has a byline. */
	locales: ReadonlyMap<string, ReadonlySet<string>>;
	/** Principals with more than one byline in some locale. */
	sharedLocale: ReadonlySet<string>;
}

export interface PlanInputs {
	packageDigest: `sha256:${string}`;
	manifest: SitePackageManifest;
	target: PlanTarget;
	summary: ValidationSummary;
	validationBlockers: readonly PlanBlocker[];
	validationWarnings: readonly PlanWarning[];
	targetBlockers: readonly PlanBlocker[];
	scaffold: readonly ScaffoldItem[];
	redirectLoops: readonly string[];
	localeRecasing: ReadonlyArray<{ from: string; to: string }>;
	suggestions: ReadonlyMap<string, string>;
	targetSettings: { title?: string; tagline?: string };
}

const TRANSFORMATION_ORDER: readonly string[] = [
	...EXPORT_TRANSFORMATION_CODES,
	...IMPORT_TRANSFORMATION_CODES,
];

/** Export transformations first, then import transformations; each in vocabulary order. */
function sortTransformations(transformations: PlanTransformation[]): PlanTransformation[] {
	return transformations.toSorted(
		(a, b) => TRANSFORMATION_ORDER.indexOf(a.code) - TRANSFORMATION_ORDER.indexOf(b.code),
	);
}

function externalProviderWarnings(summary: ValidationSummary): PlanWarning[] {
	return [...summary.externalProviders].slice(0, MAX_PROVIDER_WARNINGS).map(([provider, uses]) => ({
		code: "media_provider_external",
		message: "Content uses media from an external provider, which is not copied",
		count: uses,
		detail: { provider },
	}));
}

function uncheckedRedirectWarnings(manifest: SitePackageManifest): PlanWarning[] {
	const count = manifest.records.redirect?.count ?? 0;
	if (count <= MAX_LOOP_CHECKED_REDIRECTS) return [];
	return [
		{
			code: "redirect_loops_unchecked",
			message:
				"The package has too many redirects to check for loops before importing; a redirect that would close a loop is imported disabled",
			kind: "redirect",
			count,
		},
	];
}

function estimateSteps(manifest: SitePackageManifest): number {
	let chunks = 0;
	for (const summary of Object.values(manifest.records)) chunks += summary?.chunks ?? 0;
	return (
		FIXED_IMPORT_STEPS + chunks + Math.ceil(manifest.media.totalBytes / TRANSFER_LIMITS.stepBytes)
	);
}

export function defaultDecisions(
	principals: readonly Pick<PlanPrincipal, "id" | "suggestedUserId">[],
): SiteImportDecisions {
	return {
		principalMappings: Object.fromEntries(
			principals.map((principal) => [principal.id, principal.suggestedUserId ?? null]),
		),
		siteTitle: "package",
		siteTagline: "package",
	};
}

function settingSummary(packageValue?: string, targetValue?: string) {
	return {
		...(packageValue === undefined ? {} : { package: packageValue }),
		...(targetValue === undefined ? {} : { target: targetValue.slice(0, 4096) }),
	};
}

/** Build the plan with default decisions applied. */
export function buildPlan(inputs: PlanInputs, bylines: PrincipalBylines): SiteImportPlan {
	const { manifest, summary } = inputs;

	const principals: PlanPrincipal[] = summary.principals.map((principal) => {
		const suggestedUserId = inputs.suggestions.get(principal.id);
		return {
			id: principal.id,
			displayName: principal.displayName,
			...(principal.email === undefined ? {} : { email: principal.email }),
			references: summary.principalReferences.get(principal.id) ?? 0,
			...(suggestedUserId === undefined ? {} : { suggestedUserId }),
		};
	});

	const transformations: PlanTransformation[] = [...manifest.transformations];
	if (inputs.scaffold.length > 0) {
		transformations.push({
			code: "seeded_scaffold_removed",
			count: inputs.scaffold.length,
			items: inputs.scaffold
				.slice(0, MAX_LISTED_IDS)
				.map((item) => ({ type: item.type, id: item.id })),
		});
	}
	if (inputs.redirectLoops.length > 0) {
		transformations.push({
			code: "redirect_loop_disabled",
			kind: "redirect",
			ids: inputs.redirectLoops.slice(0, MAX_LISTED_IDS),
		});
	}
	if (inputs.localeRecasing.length > 0) {
		transformations.push({ code: "locale_recased", locales: [...inputs.localeRecasing] });
	}
	if (inputs.target.dialect === "postgres") {
		if (summary.searchEnabledCollections.length > 0) {
			transformations.push({
				code: "search_unsupported",
				kind: "collection",
				ids: summary.searchEnabledCollections.slice(0, MAX_LISTED_IDS),
			});
		}
		if (summary.float4Rounded > 0) {
			transformations.push({ code: "float4_rounded", count: summary.float4Rounded });
		}
	}

	const plan: SiteImportPlan = {
		formatVersion: SITE_PACKAGE_FORMAT_VERSION,
		packageDigest: inputs.packageDigest,
		origin: {
			siteId: manifest.originSiteId,
			packageId: manifest.packageId,
			createdAt: manifest.createdAt,
			createdByEmDashVersion: manifest.createdByEmDashVersion,
		},
		target: inputs.target,
		counts: Object.fromEntries(
			Object.entries(manifest.records).map(([kind, record]) => [kind, record.count]),
		),
		bytes: { records: summary.recordBytes, media: manifest.media.totalBytes },
		principals,
		settings: {
			title: settingSummary(summary.settings.title, inputs.targetSettings.title),
			tagline: settingSummary(summary.settings.tagline, inputs.targetSettings.tagline),
		},
		decisions: defaultDecisions(principals),
		transformations,
		warnings: [
			...inputs.validationWarnings,
			...externalProviderWarnings(summary),
			...uncheckedRedirectWarnings(manifest),
		],
		blockers: [...inputs.validationBlockers, ...inputs.targetBlockers],
		estimatedSteps: estimateSteps(manifest),
	};
	return applyDecisions(plan, plan.decisions, bylines);
}

/**
 * A plan for a package whose manifest could not be read: identity and
 * blockers only.
 */
export function buildBlockedPlan(input: {
	packageDigest: `sha256:${string}`;
	origin: PlanOrigin;
	target: PlanTarget;
	blockers: readonly PlanBlocker[];
	warnings: readonly PlanWarning[];
}): SiteImportPlan {
	return siteImportPlanSchema.parse({
		formatVersion: SITE_PACKAGE_FORMAT_VERSION,
		packageDigest: input.packageDigest,
		origin: input.origin,
		target: input.target,
		counts: {},
		bytes: { records: 0, media: 0 },
		principals: [],
		settings: { title: {}, tagline: {} },
		decisions: defaultDecisions([]),
		transformations: [],
		warnings: [...input.warnings],
		blockers: [...input.blockers],
		estimatedSteps: 0,
	});
}

/**
 * The plan with `decisions` in place and every decision-dependent
 * transformation and blocker recomputed.
 */
export function applyDecisions(
	plan: SiteImportPlan,
	decisions: SiteImportDecisions,
	bylines: PrincipalBylines,
): SiteImportPlan {
	let mappedReferences = 0;
	let unmappedReferences = 0;
	const principalsByUser = new Map<string, string[]>();
	const conflicts: PlanBlocker[] = [];
	for (const principal of plan.principals) {
		const userId = Object.hasOwn(decisions.principalMappings, principal.id)
			? decisions.principalMappings[principal.id]
			: null;
		if (userId === null || userId === undefined) {
			unmappedReferences += principal.references;
			continue;
		}
		mappedReferences += principal.references;
		if (bylines.sharedLocale.has(principal.id)) {
			conflicts.push({
				code: "principal_conflict",
				message: "A principal with several bylines in one locale is mapped to a user",
				kind: "principal",
				id: principal.id,
				detail: { user: userId },
			});
		}
		const list = principalsByUser.get(userId) ?? [];
		list.push(principal.id);
		principalsByUser.set(userId, list);
	}

	for (const [userId, principalIds] of principalsByUser) {
		for (let i = 0; i < principalIds.length; i++) {
			for (let j = i + 1; j < principalIds.length; j++) {
				const first = principalIds[i];
				const second = principalIds[j];
				if (first === undefined || second === undefined) continue;
				const firstLocales = bylines.locales.get(first);
				const secondLocales = bylines.locales.get(second);
				if (!firstLocales || !secondLocales) continue;
				if (![...firstLocales].some((locale) => secondLocales.has(locale))) continue;
				conflicts.push({
					code: "principal_conflict",
					message: "Two principals with bylines in the same locale are mapped to one user",
					kind: "principal",
					id: second,
					detail: { principal: first, user: userId },
				});
			}
		}
	}

	const transformations = plan.transformations.filter(
		(transformation) => !DECISION_TRANSFORMATION_CODES.has(transformation.code),
	);
	if (mappedReferences > 0) {
		transformations.push({ code: "principal_mapped", count: mappedReferences });
	}
	if (unmappedReferences > 0) {
		transformations.push({ code: "principal_unmapped", count: unmappedReferences });
	}

	return siteImportPlanSchema.parse({
		...plan,
		decisions,
		transformations: sortTransformations(transformations),
		blockers: [
			...plan.blockers.filter((blocker) => !DECISION_BLOCKER_CODES.has(blocker.code)),
			...conflicts,
		],
	});
}
