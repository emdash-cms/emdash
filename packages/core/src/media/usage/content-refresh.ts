import { sql, type Kysely } from "kysely";

import { tableExists } from "../../database/dialect-helpers.js";
import {
	type MediaUsageExistingSourceProjection,
	MediaUsageRepository,
	type MediaUsageNewSourceProjection,
	type MediaUsageSource,
} from "../../database/repositories/media-usage.js";
import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import { isI18nEnabled } from "../../i18n/config.js";
import {
	loadContentMediaUsageFields,
	type ContentMediaUsageFieldDiscovery,
} from "./content-fields.js";
import {
	CONTENT_SOURCE_SCHEMA_VERSION,
	loadContentMediaUsageSnapshots,
	loadContentMediaUsageSnapshotsBatch,
	type ContentMediaUsageSnapshot,
	type LoadContentMediaUsageSnapshotsResult,
} from "./content-snapshots.js";
import {
	buildContentMediaUsageSourceKey,
	MEDIA_USAGE_CONTENT_SOURCE_VARIANTS,
} from "./source-key.js";

export const CONTENT_MEDIA_USAGE_ADAPTER_ID = "content-media";
export const CONTENT_MEDIA_USAGE_COLLECTION_SCOPE = "collection";

const CONTENT_USAGE_LOCKS_KEY = Symbol.for("emdash.mediaUsage.contentLocks");
const CONTENT_USAGE_COLLECTION_LOCKS_KEY = Symbol.for("emdash.mediaUsage.collectionLocks");
const CONTENT_USAGE_REFRESH_MAX_ATTEMPTS = 2;

export const MEDIA_USAGE_PROJECTION_ADMISSION_LIMITS = Object.freeze({
	maxOccurrenceMutationUnitsPerClaim: 500,
	maxProjectionMutationBytesPerVariant: 2_000_000,
	maxProjectionMutationBytesPerClaim: 4_000_000,
	maxOccurrenceMutationUnitsPerBatch: 50_000,
	maxProjectionMutationBytesPerBatch: 16_000_000,
});

export interface ContentMediaUsageAdmissionBudget {
	remainingOccurrenceMutationUnits: number;
	remainingProjectionMutationBytes: number;
	hasReservedMutation: boolean;
}

export type ContentMediaUsageProjectionAdmissionResult =
	| {
			outcome: "admitted";
			noOpSourceKeys: ReadonlySet<string>;
			absentSources: MediaUsageSource[];
			occurrenceMutationUnits: number;
			projectionMutationBytes: number;
	  }
	| { outcome: "intrinsic_resource_limit" }
	| { outcome: "claim_budget_deferred" };

// These maps only de-dupe usage work inside the current isolate/process. Cross-worker
// correctness comes from expected-generation guards on repository writes.

export type ContentMediaUsageRefreshErrorCode =
	| "CONTENT_NOT_FOUND"
	| "DRAFT_REVISION_NOT_FOUND"
	| "DRAFT_REVISION_MISMATCH"
	| "DRAFT_REVISION_INVALID"
	| "CONTENT_USAGE_REFRESH_ERROR"
	| "CONTENT_USAGE_DELETE_ERROR"
	| "CONTENT_USAGE_GENERATION_CONFLICT"
	| "CONTENT_USAGE_RESOURCE_LIMIT"
	| "CONTENT_USAGE_STALE";

interface ContentMediaUsageRefreshOptions {
	collectionId?: string;
	durableWork?: boolean;
	admissionBudget?: ContentMediaUsageAdmissionBudget;
	fieldDiscovery?: ContentMediaUsageFieldDiscovery;
	observedSources?: ReadonlyMap<string, MediaUsageSource>;
	snapshotsResult?: LoadContentMediaUsageSnapshotsResult;
}

export interface ContentMediaUsageRefreshResult {
	success: boolean;
	refreshedSourceCount: number;
	deletedSourceCount: number;
	failedSourceCount: number;
	errorCode?: ContentMediaUsageRefreshErrorCode;
}

const ZERO_RESULT: ContentMediaUsageRefreshResult = {
	success: true,
	refreshedSourceCount: 0,
	deletedSourceCount: 0,
	failedSourceCount: 0,
};

export function createContentMediaUsageAdmissionBudget(
	limits: {
		maxOccurrenceMutationUnits?: number;
		maxProjectionMutationBytes?: number;
	} = {},
): ContentMediaUsageAdmissionBudget {
	return {
		remainingOccurrenceMutationUnits:
			limits.maxOccurrenceMutationUnits ??
			MEDIA_USAGE_PROJECTION_ADMISSION_LIMITS.maxOccurrenceMutationUnitsPerClaim,
		remainingProjectionMutationBytes:
			limits.maxProjectionMutationBytes ??
			MEDIA_USAGE_PROJECTION_ADMISSION_LIMITS.maxProjectionMutationBytesPerClaim,
		hasReservedMutation: false,
	};
}

export async function planContentMediaUsageProjectionAdmission(
	repo: MediaUsageRepository,
	snapshots: readonly ContentMediaUsageSnapshot[],
	observedSources: ReadonlyMap<string, MediaUsageSource>,
	canonicalSourceKeys: readonly string[],
	budget: ContentMediaUsageAdmissionBudget,
): Promise<ContentMediaUsageProjectionAdmissionResult> {
	const snapshotSourceKeys = new Set(snapshots.map((snapshot) => snapshot.source.sourceKey));
	const absentSources = canonicalSourceKeys
		.filter((sourceKey) => !snapshotSourceKeys.has(sourceKey))
		.map((sourceKey) => observedSources.get(sourceKey))
		.filter((source): source is MediaUsageSource => source !== undefined);
	let deletionOccurrenceUnits = 0;
	let deletionBytes = 0;
	let largestDeletionBytes = 0;
	for (const source of absentSources) {
		const measurement = await repo.measureSourceGenerationDeletion(
			source.sourceKey,
			source.currentGeneration,
			MEDIA_USAGE_PROJECTION_ADMISSION_LIMITS.maxOccurrenceMutationUnitsPerClaim,
		);
		if (measurement.exceedsOccurrenceLimit) {
			return budget.hasReservedMutation
				? { outcome: "claim_budget_deferred" }
				: { outcome: "intrinsic_resource_limit" };
		}
		deletionOccurrenceUnits += measurement.occurrenceCount;
		const sourceDeletionBytes =
			storedMediaUsageSourceByteLength(source) + measurement.occurrenceBytes * 2;
		deletionBytes += sourceDeletionBytes;
		largestDeletionBytes = Math.max(largestDeletionBytes, sourceDeletionBytes);
	}

	const noOpSourceKeys = new Set<string>();
	let cost = projectionAdmissionCost(
		snapshots,
		noOpSourceKeys,
		deletionOccurrenceUnits,
		deletionBytes,
		largestDeletionBytes,
	);
	if (exceedsProjectionAdmissionLimits(cost)) {
		for (const snapshot of snapshots) {
			const expectedSource = observedSources.get(snapshot.source.sourceKey);
			if (
				expectedSource &&
				(await repo.projectionMatchesExpectedSource(snapshot.source, expectedSource))
			) {
				noOpSourceKeys.add(snapshot.source.sourceKey);
			}
		}
		cost = projectionAdmissionCost(
			snapshots,
			noOpSourceKeys,
			deletionOccurrenceUnits,
			deletionBytes,
			largestDeletionBytes,
		);
	}

	if (exceedsProjectionAdmissionLimits(cost)) {
		return budget.hasReservedMutation
			? { outcome: "claim_budget_deferred" }
			: { outcome: "intrinsic_resource_limit" };
	}
	if (
		cost.occurrenceMutationUnits > budget.remainingOccurrenceMutationUnits ||
		cost.projectionMutationBytes > budget.remainingProjectionMutationBytes
	) {
		return { outcome: "claim_budget_deferred" };
	}

	budget.remainingOccurrenceMutationUnits -= cost.occurrenceMutationUnits;
	budget.remainingProjectionMutationBytes -= cost.projectionMutationBytes;
	if (cost.occurrenceMutationUnits > 0 || cost.projectionMutationBytes > 0) {
		budget.hasReservedMutation = true;
	}
	return {
		outcome: "admitted",
		noOpSourceKeys,
		absentSources,
		...cost,
	};
}

interface ProjectionAdmissionCost {
	occurrenceMutationUnits: number;
	projectionMutationBytes: number;
	largestProjectionMutationBytes: number;
}

function projectionAdmissionCost(
	snapshots: readonly ContentMediaUsageSnapshot[],
	noOpSourceKeys: ReadonlySet<string>,
	deletionOccurrenceUnits: number,
	deletionBytes: number,
	largestDeletionBytes: number,
): ProjectionAdmissionCost {
	return snapshots.reduce<ProjectionAdmissionCost>(
		(cost, snapshot) => {
			if (noOpSourceKeys.has(snapshot.source.sourceKey)) return cost;
			cost.occurrenceMutationUnits += snapshot.occurrences.length;
			cost.projectionMutationBytes += snapshot.projectionByteLength;
			cost.largestProjectionMutationBytes = Math.max(
				cost.largestProjectionMutationBytes,
				snapshot.projectionByteLength,
			);
			return cost;
		},
		{
			occurrenceMutationUnits: deletionOccurrenceUnits,
			projectionMutationBytes: deletionBytes,
			largestProjectionMutationBytes: largestDeletionBytes,
		},
	);
}

function exceedsProjectionAdmissionLimits(cost: ProjectionAdmissionCost): boolean {
	return (
		cost.occurrenceMutationUnits >
			MEDIA_USAGE_PROJECTION_ADMISSION_LIMITS.maxOccurrenceMutationUnitsPerClaim ||
		cost.largestProjectionMutationBytes >
			MEDIA_USAGE_PROJECTION_ADMISSION_LIMITS.maxProjectionMutationBytesPerVariant ||
		cost.projectionMutationBytes >
			MEDIA_USAGE_PROJECTION_ADMISSION_LIMITS.maxProjectionMutationBytesPerClaim
	);
}

function storedMediaUsageSourceByteLength(source: MediaUsageSource): number {
	return new TextEncoder().encode(JSON.stringify(source)).byteLength;
}

export async function refreshContentMediaUsage(
	db: Kysely<Database>,
	collectionSlug: string,
	contentId: string,
): Promise<ContentMediaUsageRefreshResult> {
	validateIdentifier(collectionSlug, "collection slug");
	return withContentUsageCollectionLock(collectionSlug, () =>
		withContentUsageLock(collectionSlug, contentId, () =>
			refreshContentMediaUsageUnlocked(db, collectionSlug, contentId, {}),
		),
	);
}

export interface ContentMediaUsageWorkRefreshInput {
	collectionId: string;
	collectionSlug: string;
	contentId: string;
}

export interface ContentMediaUsageWorkBatchOptions {
	shouldContinue?: () => boolean;
}

export async function refreshContentMediaUsageForWorkBatch(
	db: Kysely<Database>,
	items: readonly ContentMediaUsageWorkRefreshInput[],
	options: ContentMediaUsageWorkBatchOptions = {},
): Promise<Map<string, ContentMediaUsageRefreshResult>> {
	const results = new Map<string, ContentMediaUsageRefreshResult>();
	const batchBudget = createContentMediaUsageAdmissionBudget({
		maxOccurrenceMutationUnits:
			MEDIA_USAGE_PROJECTION_ADMISSION_LIMITS.maxOccurrenceMutationUnitsPerBatch,
		maxProjectionMutationBytes:
			MEDIA_USAGE_PROJECTION_ADMISSION_LIMITS.maxProjectionMutationBytesPerBatch,
	});
	const collections = new Map<string, ContentMediaUsageWorkRefreshInput[]>();
	for (const item of items) {
		const key = `${item.collectionId}\u0000${item.collectionSlug}`;
		const collectionItems = collections.get(key) ?? [];
		collectionItems.push(item);
		collections.set(key, collectionItems);
	}
	for (const collectionItems of collections.values()) {
		if (options.shouldContinue && !options.shouldContinue()) break;
		const first = collectionItems[0];
		if (!first) continue;
		validateIdentifier(first.collectionSlug, "collection slug");
		if (!first.collectionId)
			throw new Error("Durable media usage work requires a collection identity");
		await withContentUsageCollectionLock(first.collectionSlug, async () => {
			const fieldDiscovery = await loadContentMediaUsageFields(
				db,
				first.collectionSlug,
				first.collectionId,
			);
			const sourceKeys = collectionItems.flatMap((item) =>
				contentSourceKeys(item.collectionSlug, item.contentId, item.collectionId),
			);
			const repo = new MediaUsageRepository(db);
			const observedSources = await repo.findSources(sourceKeys);
			const snapshots = await loadContentMediaUsageSnapshotsBatch(
				db,
				first.collectionSlug,
				collectionItems.map((item) => item.contentId),
				fieldDiscovery,
				{ collectionId: first.collectionId, identityVersion: 1 },
				{
					shouldContinue: options.shouldContinue,
					maxOccurrenceCount:
						MEDIA_USAGE_PROJECTION_ADMISSION_LIMITS.maxOccurrenceMutationUnitsPerBatch,
					maxProjectionBytes:
						MEDIA_USAGE_PROJECTION_ADMISSION_LIMITS.maxProjectionMutationBytesPerBatch,
				},
			);
			const newSourceProjections: MediaUsageNewSourceProjection[] = [];
			const newSourceKeys = new Map<string, string[]>();
			const existingSourceProjections: MediaUsageExistingSourceProjection[] = [];
			const unchangedSourceProjections: MediaUsageExistingSourceProjection[] = [];
			const existingSourceKeys = new Map<
				string,
				{ allCount: number; changed: string[]; unchanged: string[] }
			>();
			for (const item of collectionItems) {
				if (options.shouldContinue && !options.shouldContinue()) break;
				const snapshotsResult = snapshots.get(item.contentId);
				const itemSourceKeys = contentSourceKeys(
					item.collectionSlug,
					item.contentId,
					item.collectionId,
				);
				if (!snapshotsResult?.success) {
					continue;
				}
				const snapshotsByKey = new Map(
					snapshotsResult.snapshots.map(
						(snapshot) => [snapshot.source.sourceKey, snapshot] as const,
					),
				);
				const existing = itemSourceKeys
					.map((sourceKey) => observedSources.get(sourceKey))
					.filter((source): source is MediaUsageSource => source !== undefined);
				const allNew = existing.length === 0;
				const allExisting =
					existing.length === snapshotsResult.snapshots.length &&
					existing.every((source) => snapshotsByKey.has(source.sourceKey));
				if (!allNew && !allExisting) continue;
				const admission = await planContentMediaUsageProjectionAdmission(
					repo,
					snapshotsResult.snapshots,
					observedSources,
					itemSourceKeys,
					batchBudget,
				);
				if (admission.outcome === "claim_budget_deferred") break;
				if (admission.outcome !== "admitted") {
					results.set(
						contentRefreshKey(item.collectionId, item.contentId),
						admissionFailureResult(admission.outcome),
					);
					continue;
				}
				const key = contentRefreshKey(item.collectionId, item.contentId);
				if (allNew) {
					newSourceProjections.push(
						...snapshotsResult.snapshots.map((snapshot) => ({
							source: snapshot.source,
							occurrences: snapshot.occurrences,
						})),
					);
					newSourceKeys.set(
						key,
						snapshotsResult.snapshots.map((snapshot) => snapshot.source.sourceKey),
					);
					continue;
				}
				const changed: string[] = [];
				const unchanged: string[] = [];
				for (const snapshot of snapshotsResult.snapshots) {
					const expectedSource = observedSources.get(snapshot.source.sourceKey);
					if (!expectedSource) continue;
					if (
						expectedSource.sourceFingerprint === snapshot.source.sourceFingerprint &&
						expectedSource.sourceCompleteness ===
							(snapshot.source.sourceCompleteness ?? "complete") &&
						expectedSource.lastErrorCode === null
					) {
						unchanged.push(snapshot.source.sourceKey);
						unchangedSourceProjections.push({
							source: snapshot.source,
							occurrences: snapshot.occurrences,
							expectedSource,
						});
						continue;
					}
					changed.push(snapshot.source.sourceKey);
					existingSourceProjections.push({
						source: snapshot.source,
						occurrences: snapshot.occurrences,
						expectedSource,
					});
				}
				existingSourceKeys.set(key, {
					allCount: snapshotsResult.snapshots.length,
					changed,
					unchanged,
				});
			}
			const insertedSourceKeys = await repo.replaceNewSourcesBatch(newSourceProjections);
			const replacedSourceKeys = await repo.replaceExistingSourcesBatch(existingSourceProjections);
			const matchedSourceKeys = await repo.matchingExistingSourcesBatch(unchangedSourceProjections);
			for (const [key, expectedSourceKeys] of newSourceKeys) {
				results.set(
					key,
					expectedSourceKeys.every((sourceKey) => insertedSourceKeys.has(sourceKey))
						? {
								success: true,
								refreshedSourceCount: expectedSourceKeys.length,
								deletedSourceCount: 0,
								failedSourceCount: 0,
							}
						: generationConflictResult({ refreshedSourceCount: 0, deletedSourceCount: 0 }),
				);
			}
			for (const [key, expected] of existingSourceKeys) {
				results.set(
					key,
					expected.changed.every((sourceKey) => replacedSourceKeys.has(sourceKey)) &&
						expected.unchanged.every((sourceKey) => matchedSourceKeys.has(sourceKey))
						? {
								success: true,
								refreshedSourceCount: expected.allCount,
								deletedSourceCount: 0,
								failedSourceCount: 0,
							}
						: generationConflictResult({ refreshedSourceCount: 0, deletedSourceCount: 0 }),
				);
			}
			for (const item of collectionItems) {
				if (options.shouldContinue && !options.shouldContinue()) break;
				const key = contentRefreshKey(item.collectionId, item.contentId);
				if (!snapshots.has(item.contentId)) continue;
				if (results.has(key)) continue;
				const result = await withContentUsageLock(item.collectionSlug, item.contentId, () =>
					refreshContentMediaUsageUnlocked(db, item.collectionSlug, item.contentId, {
						collectionId: item.collectionId,
						durableWork: true,
						fieldDiscovery,
						observedSources,
						snapshotsResult: snapshots.get(item.contentId),
					}),
				);
				results.set(key, result);
			}
		});
	}
	return results;
}

async function refreshContentMediaUsageUnlocked(
	db: Kysely<Database>,
	collectionSlug: string,
	contentId: string,
	options: ContentMediaUsageRefreshOptions,
): Promise<ContentMediaUsageRefreshResult> {
	try {
		let conflictResult: ContentMediaUsageRefreshResult | null = null;
		if (options.durableWork) options.admissionBudget = createContentMediaUsageAdmissionBudget();
		for (let attempt = 0; attempt < CONTENT_USAGE_REFRESH_MAX_ATTEMPTS; attempt++) {
			const result = await refreshContentMediaUsageAttempt(db, collectionSlug, contentId, options);
			if (result.errorCode !== "CONTENT_USAGE_GENERATION_CONFLICT") return result;
			conflictResult = result;
			if (options.admissionBudget?.hasReservedMutation) break;
		}

		if (options.durableWork) {
			return generationConflictResult({
				refreshedSourceCount: conflictResult?.refreshedSourceCount ?? 0,
				deletedSourceCount: conflictResult?.deletedSourceCount ?? 0,
			});
		}
		return markGenerationConflict(db, collectionSlug, {
			refreshedSourceCount: conflictResult?.refreshedSourceCount ?? 0,
			deletedSourceCount: conflictResult?.deletedSourceCount ?? 0,
		});
	} catch (error) {
		console.error(`[media-usage] Failed to refresh ${collectionSlug}/${contentId}:`, error);
		if (!options.durableWork) {
			await markContentMediaUsageCollectionStaleSafely(
				db,
				collectionSlug,
				"CONTENT_USAGE_REFRESH_ERROR",
			);
		}
		return {
			success: false,
			refreshedSourceCount: 0,
			deletedSourceCount: 0,
			failedSourceCount: 0,
			errorCode: "CONTENT_USAGE_REFRESH_ERROR",
		};
	}
}

async function refreshContentMediaUsageAttempt(
	db: Kysely<Database>,
	collectionSlug: string,
	contentId: string,
	options: ContentMediaUsageRefreshOptions,
): Promise<ContentMediaUsageRefreshResult> {
	const repo = new MediaUsageRepository(db);
	const canonicalSourceKeys = contentSourceKeys(collectionSlug, contentId, options.collectionId);
	const observedSources = options.observedSources ?? (await repo.findSources(canonicalSourceKeys));
	const snapshotsResult =
		options.snapshotsResult ??
		(await loadContentMediaUsageSnapshots(
			db,
			collectionSlug,
			contentId,
			options.fieldDiscovery,
			options.collectionId ? { collectionId: options.collectionId, identityVersion: 1 } : undefined,
		));
	if (!snapshotsResult.success) {
		if (snapshotsResult.error === "CONTENT_NOT_FOUND" && options.collectionId) {
			if (!options.admissionBudget)
				throw new Error("Durable media usage work requires an admission budget");
			const admission = await planContentMediaUsageProjectionAdmission(
				repo,
				[],
				observedSources,
				canonicalSourceKeys,
				options.admissionBudget,
			);
			if (admission.outcome !== "admitted") return admissionFailureResult(admission.outcome);
			return deleteCanonicalContentSourcesIfAbsent(
				repo,
				admission.absentSources,
				collectionSlug,
				contentId,
			);
		}
		if (
			snapshotsResult.error === "CONTENT_NOT_FOUND" &&
			!(await contentCollectionExists(db, collectionSlug))
		) {
			const deletedSourceCount = await repo.deleteContentSources(collectionSlug, contentId);
			return { ...ZERO_RESULT, deletedSourceCount };
		}
		return options.durableWork
			? snapshotFailureResult(snapshotsResult)
			: markSnapshotFailure(db, collectionSlug, snapshotsResult);
	}

	if (!options.collectionId && !(await contentCollectionExists(db, collectionSlug))) {
		const deletedSourceCount = await repo.deleteContentSources(collectionSlug, contentId);
		return { ...ZERO_RESULT, deletedSourceCount };
	}
	const admission = options.admissionBudget
		? await planContentMediaUsageProjectionAdmission(
				repo,
				snapshotsResult.snapshots,
				observedSources,
				canonicalSourceKeys,
				options.admissionBudget,
			)
		: null;
	if (admission && admission.outcome !== "admitted") {
		return admissionFailureResult(admission.outcome);
	}
	let refreshedSourceCount = 0;
	for (const snapshot of snapshotsResult.snapshots) {
		if (
			admission?.outcome === "admitted" &&
			admission.noOpSourceKeys.has(snapshot.source.sourceKey)
		) {
			refreshedSourceCount++;
			continue;
		}
		const result = await repo.replaceSourceIfMatching(
			snapshot.source,
			snapshot.occurrences,
			observedSources.get(snapshot.source.sourceKey) ?? null,
		);
		if (result.unchanged) {
			refreshedSourceCount++;
			continue;
		}
		if (!result.replaced) {
			return generationConflictResult({
				refreshedSourceCount,
				deletedSourceCount: 0,
			});
		}
		refreshedSourceCount++;
	}
	if (!options.collectionId && !(await contentCollectionExists(db, collectionSlug))) {
		const deletedSourceCount = await repo.deleteContentSources(collectionSlug, contentId);
		return { ...ZERO_RESULT, deletedSourceCount };
	}

	const expectedSourceKeys = new Set(
		snapshotsResult.snapshots.map((snapshot) => snapshot.source.sourceKey),
	);
	const absentSources =
		admission?.outcome === "admitted"
			? admission.absentSources
			: canonicalSourceKeys
					.filter((sourceKey) => !expectedSourceKeys.has(sourceKey))
					.map((sourceKey) => observedSources.get(sourceKey))
					.filter((source): source is MediaUsageSource => source !== undefined);
	let deletedSourceCount = 0;
	for (const expectedSource of absentSources) {
		const result = await repo.deleteSourceIfMatching(expectedSource.sourceKey, expectedSource);
		if (result.deleted) {
			deletedSourceCount++;
			continue;
		}
		if (result.source) {
			return generationConflictResult({
				refreshedSourceCount,
				deletedSourceCount,
			});
		}
	}

	return {
		success: true,
		refreshedSourceCount,
		deletedSourceCount,
		failedSourceCount: 0,
	};
}

export function contentRefreshKey(collectionId: string, contentId: string): string {
	return `${collectionId}\u0000${contentId}`;
}

function contentSourceKeys(
	collectionSlug: string,
	contentId: string,
	collectionId?: string,
): string[] {
	return MEDIA_USAGE_CONTENT_SOURCE_VARIANTS.map((sourceVariant) =>
		buildContentMediaUsageSourceKey({
			collectionId,
			collectionSlug,
			contentId,
			sourceVariant,
		}),
	);
}

function admissionFailureResult(
	outcome: "intrinsic_resource_limit" | "claim_budget_deferred",
): ContentMediaUsageRefreshResult {
	return {
		...generationConflictResult({ refreshedSourceCount: 0, deletedSourceCount: 0 }),
		errorCode:
			outcome === "intrinsic_resource_limit"
				? "CONTENT_USAGE_RESOURCE_LIMIT"
				: "CONTENT_USAGE_GENERATION_CONFLICT",
	};
}

async function markGenerationConflict(
	db: Kysely<Database>,
	collectionSlug: string,
	counts: Pick<ContentMediaUsageRefreshResult, "refreshedSourceCount" | "deletedSourceCount">,
): Promise<ContentMediaUsageRefreshResult> {
	await markContentMediaUsageCollectionStaleSafely(
		db,
		collectionSlug,
		"CONTENT_USAGE_GENERATION_CONFLICT",
	);
	return {
		success: false,
		refreshedSourceCount: counts.refreshedSourceCount,
		deletedSourceCount: counts.deletedSourceCount,
		failedSourceCount: 0,
		errorCode: "CONTENT_USAGE_GENERATION_CONFLICT",
	};
}

function generationConflictResult(
	counts: Pick<ContentMediaUsageRefreshResult, "refreshedSourceCount" | "deletedSourceCount">,
): ContentMediaUsageRefreshResult {
	return {
		success: false,
		refreshedSourceCount: counts.refreshedSourceCount,
		deletedSourceCount: counts.deletedSourceCount,
		failedSourceCount: 0,
		errorCode: "CONTENT_USAGE_GENERATION_CONFLICT",
	};
}

async function contentCollectionExists(
	db: Kysely<Database>,
	collectionSlug: string,
	collectionId?: string,
): Promise<boolean> {
	let query = db.selectFrom("_emdash_collections").select("id").where("slug", "=", collectionSlug);
	if (collectionId) query = query.where("id", "=", collectionId);
	const row = await query.executeTakeFirst();
	return row !== undefined;
}

export async function deleteContentMediaUsage(
	db: Kysely<Database>,
	collectionSlug: string,
	contentId: string,
): Promise<ContentMediaUsageRefreshResult> {
	validateIdentifier(collectionSlug, "collection slug");
	return withContentUsageCollectionLock(collectionSlug, () =>
		withContentUsageLock(collectionSlug, contentId, () =>
			deleteContentMediaUsageUnlocked(db, collectionSlug, contentId),
		),
	);
}

async function deleteContentMediaUsageUnlocked(
	db: Kysely<Database>,
	collectionSlug: string,
	contentId: string,
): Promise<ContentMediaUsageRefreshResult> {
	try {
		const deletedSourceCount = await new MediaUsageRepository(db).deleteContentSources(
			collectionSlug,
			contentId,
		);
		return { ...ZERO_RESULT, deletedSourceCount };
	} catch (error) {
		console.error(
			`[media-usage] Failed to delete usage for ${collectionSlug}/${contentId}:`,
			error,
		);
		await markContentMediaUsageCollectionStaleSafely(
			db,
			collectionSlug,
			"CONTENT_USAGE_DELETE_ERROR",
		);
		return {
			success: false,
			refreshedSourceCount: 0,
			deletedSourceCount: 0,
			failedSourceCount: 0,
			errorCode: "CONTENT_USAGE_DELETE_ERROR",
		};
	}
}

export async function deleteContentMediaUsageCollection(
	db: Kysely<Database>,
	collectionSlug: string,
): Promise<ContentMediaUsageRefreshResult> {
	validateIdentifier(collectionSlug, "collection slug");
	return withContentUsageCollectionLock(collectionSlug, () =>
		deleteContentMediaUsageCollectionUnlocked(db, collectionSlug),
	);
}

async function deleteContentMediaUsageCollectionUnlocked(
	db: Kysely<Database>,
	collectionSlug: string,
): Promise<ContentMediaUsageRefreshResult> {
	try {
		const repo = new MediaUsageRepository(db);
		const deletedSourceCount = await repo.deleteCollectionSources(collectionSlug);
		await repo.deleteIndexStatus({
			adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
			scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
			scopeKey: collectionSlug,
		});
		return { ...ZERO_RESULT, deletedSourceCount };
	} catch (error) {
		console.error(`[media-usage] Failed to delete usage for collection ${collectionSlug}:`, error);
		try {
			await new MediaUsageRepository(db).deleteIndexStatus({
				adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
				scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
				scopeKey: collectionSlug,
			});
		} catch (statusError) {
			console.error(
				`[media-usage] Failed to clear usage status for deleted collection ${collectionSlug}:`,
				statusError,
			);
		}
		return {
			success: false,
			refreshedSourceCount: 0,
			deletedSourceCount: 0,
			failedSourceCount: 0,
			errorCode: "CONTENT_USAGE_DELETE_ERROR",
		};
	}
}

export async function refreshContentMediaUsageAfterWrite(
	db: Kysely<Database>,
	collectionSlug: string,
	contentId: string,
): Promise<void> {
	const result = await refreshContentMediaUsage(db, collectionSlug, contentId);
	if (!result.success) {
		console.error(
			`[media-usage] Usage refresh for ${collectionSlug}/${contentId} finished with ${result.errorCode}`,
		);
	}
}

export async function markContentMediaUsageCollectionStale(
	db: Kysely<Database>,
	collectionSlug: string,
	lastErrorCode: string,
): Promise<void> {
	validateIdentifier(collectionSlug, "collection slug");
	const repo = new MediaUsageRepository(db);
	const identity = {
		adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
		scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
		scopeKey: collectionSlug,
	};
	const existing = await repo.findIndexStatus(identity);
	await repo.upsertIndexStatus({
		...identity,
		status: "stale",
		schemaVersion: existing?.schemaVersion ?? CONTENT_SOURCE_SCHEMA_VERSION,
		startedAt: existing?.startedAt ?? null,
		completedAt: existing?.completedAt ?? null,
		cursor: existing?.cursor ?? null,
		indexedSourceCount: existing?.indexedSourceCount ?? 0,
		failedSourceCount: existing?.failedSourceCount ?? 0,
		lastErrorCode,
	});
}

export async function invalidateContentMediaUsageSchemaChange(
	db: Kysely<Database>,
	collectionSlug: string,
): Promise<boolean> {
	validateIdentifier(collectionSlug, "collection slug");
	if (!(await tableExists(db, "_emdash_media_usage_activation"))) return false;
	const activation = await db
		.selectFrom("_emdash_media_usage_activation")
		.select("state")
		.where("task_key", "=", "incremental_capture")
		.executeTakeFirst();
	if (activation?.state !== "active") return false;

	const invalidated = await new MediaUsageRepository(db).invalidateIndexStatusForSchemaChange(
		collectionSlug,
	);
	if (!invalidated) {
		throw new Error(`Cannot invalidate media usage coverage for collection ${collectionSlug}`);
	}
	return true;
}

export async function findNonTranslatableSiblingContentIds(
	db: Kysely<Database>,
	collectionSlug: string,
	updatedContentId: string,
	translationGroup: string | null | undefined,
	updatedData: Record<string, unknown> | undefined,
): Promise<string[]> {
	if (!isI18nEnabled() || !updatedData || !translationGroup) return [];

	validateIdentifier(collectionSlug, "collection slug");
	const collection = await db
		.selectFrom("_emdash_collections")
		.select("id")
		.where("slug", "=", collectionSlug)
		.executeTakeFirst();
	if (!collection) return [];

	const fields = await db
		.selectFrom("_emdash_fields")
		.select("slug")
		.where("collection_id", "=", collection.id)
		.where("translatable", "=", 0)
		.execute();

	const touchedNonTranslatableSlugs = fields
		.filter((field) => field.slug in updatedData)
		.map((field) => field.slug);
	if (touchedNonTranslatableSlugs.length === 0) return [];

	const usageFields = await loadContentMediaUsageFields(db, collectionSlug);
	const usageRelevantSlugs = new Set([
		...usageFields.extractionFields.map((field) => field.slug),
		...usageFields.displayFieldSlugs,
	]);
	if (!touchedNonTranslatableSlugs.some((slug) => usageRelevantSlugs.has(slug))) return [];

	const tableName = `ec_${collectionSlug}`;
	const rows = await sql<{ id: string }>`
		SELECT id
		FROM ${sql.ref(tableName)}
		WHERE translation_group = ${translationGroup}
		AND id != ${updatedContentId}
		ORDER BY id ASC
	`.execute(db);

	return rows.rows.map((row) => row.id);
}

async function markSnapshotFailure(
	db: Kysely<Database>,
	collectionSlug: string,
	result: Exclude<Awaited<ReturnType<typeof loadContentMediaUsageSnapshots>>, { success: true }>,
): Promise<ContentMediaUsageRefreshResult> {
	const repo = new MediaUsageRepository(db);
	if (result.source) {
		await repo.markSourceAttempted({
			...result.source,
			sourceCompleteness: "failed",
			lastErrorCode: result.error,
		});
	}
	await markContentMediaUsageCollectionStale(db, collectionSlug, result.error);
	return {
		success: false,
		refreshedSourceCount: 0,
		deletedSourceCount: 0,
		failedSourceCount: result.source ? 1 : 0,
		errorCode: result.error,
	};
}

function snapshotFailureResult(
	result: Exclude<Awaited<ReturnType<typeof loadContentMediaUsageSnapshots>>, { success: true }>,
): ContentMediaUsageRefreshResult {
	return {
		success: false,
		refreshedSourceCount: 0,
		deletedSourceCount: 0,
		failedSourceCount: result.source ? 1 : 0,
		errorCode: result.error,
	};
}

async function deleteCanonicalContentSourcesIfAbsent(
	repo: MediaUsageRepository,
	observedSources: readonly MediaUsageSource[],
	collectionSlug: string,
	contentId: string,
): Promise<ContentMediaUsageRefreshResult> {
	let deletedSourceCount = 0;
	for (const source of observedSources) {
		const result = await repo.deleteSourceIfMatchingContentAbsent(
			source.sourceKey,
			source,
			collectionSlug,
			contentId,
		);
		if (result.deleted) {
			deletedSourceCount++;
			continue;
		}
		if (result.contentPresent || result.source) {
			return generationConflictResult({ refreshedSourceCount: 0, deletedSourceCount });
		}
	}
	return { ...ZERO_RESULT, deletedSourceCount };
}

export async function markContentMediaUsageCollectionStaleSafely(
	db: Kysely<Database>,
	collectionSlug: string,
	lastErrorCode: ContentMediaUsageRefreshErrorCode,
): Promise<boolean> {
	try {
		await markContentMediaUsageCollectionStale(db, collectionSlug, lastErrorCode);
		return true;
	} catch (error) {
		console.error(`[media-usage] Failed to mark ${collectionSlug} stale:`, error);
		return false;
	}
}

async function withContentUsageLock<T>(
	collectionSlug: string,
	contentId: string,
	fn: () => Promise<T>,
): Promise<T> {
	const locks = getContentUsageLocks();
	const lockKey = `${collectionSlug}\0${contentId}`;
	const previous = locks.get(lockKey) ?? Promise.resolve();
	let releaseCurrent!: () => void;
	const current = new Promise<void>((resolve) => {
		releaseCurrent = resolve;
	});
	const next = previous.catch(() => {}).then(() => current);
	locks.set(lockKey, next);

	try {
		await previous.catch(() => {});
		return await fn();
	} finally {
		releaseCurrent();
		if (locks.get(lockKey) === next) locks.delete(lockKey);
	}
}

export async function withContentUsageCollectionLock<T>(
	collectionSlug: string,
	fn: () => Promise<T>,
): Promise<T> {
	// Coarse by design: row refreshes and collection source deletes must not interleave.
	const locks = getContentUsageCollectionLocks();
	const previous = locks.get(collectionSlug) ?? Promise.resolve();
	let releaseCurrent!: () => void;
	const current = new Promise<void>((resolve) => {
		releaseCurrent = resolve;
	});
	const next = previous.catch(() => {}).then(() => current);
	locks.set(collectionSlug, next);

	try {
		await previous.catch(() => {});
		return await fn();
	} finally {
		releaseCurrent();
		if (locks.get(collectionSlug) === next) locks.delete(collectionSlug);
	}
}

function getContentUsageLocks(): Map<string, Promise<void>> {
	const global = globalThis as typeof globalThis & Record<symbol, unknown>;
	const existing = global[CONTENT_USAGE_LOCKS_KEY];
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis symbol slot stores only this map
	if (existing instanceof Map) return existing as Map<string, Promise<void>>;
	const locks = new Map<string, Promise<void>>();
	global[CONTENT_USAGE_LOCKS_KEY] = locks;
	return locks;
}

function getContentUsageCollectionLocks(): Map<string, Promise<void>> {
	const global = globalThis as typeof globalThis & Record<symbol, unknown>;
	const existing = global[CONTENT_USAGE_COLLECTION_LOCKS_KEY];
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis symbol slot stores only this map
	if (existing instanceof Map) return existing as Map<string, Promise<void>>;
	const locks = new Map<string, Promise<void>>();
	global[CONTENT_USAGE_COLLECTION_LOCKS_KEY] = locks;
	return locks;
}
