import type { Kysely } from "kysely";

import {
	MediaUsageWorkRepository,
	type MediaUsageWorkRecord,
} from "../../database/repositories/media-usage-work.js";
import { MediaUsageRepository } from "../../database/repositories/media-usage.js";
import type { Database } from "../../database/types.js";
import {
	refreshContentMediaUsageForWork,
	type ContentMediaUsageRefreshErrorCode,
} from "./content-refresh.js";

export const MEDIA_USAGE_WORK_PROCESSING_LIMITS = Object.freeze({
	candidatesPerTick: 4,
	jobsPerTick: 1,
	maxTickDurationMs: 5_000,
	leaseDurationSeconds: 60,
	maxAttempts: 5,
	retryBaseSeconds: 30,
	retryMaxSeconds: 15 * 60,
	retryJitterRatio: 0.25,
	ordinaryStatementsPerJob: 20,
});

export type MediaUsageWorkProcessingOutcome =
	| "inactive"
	| "not_due"
	| "claim_lost"
	| "completed"
	| "retry"
	| "failed"
	| "superseded"
	| "obsolete";

export interface MediaUsageWorkProcessingResult {
	outcome: MediaUsageWorkProcessingOutcome;
	claimed: boolean;
}

export interface MediaUsageWorkTickResult {
	candidateCount: number;
	claimedCount: number;
	completedCount: number;
	retryCount: number;
	failedCount: number;
	supersededCount: number;
	obsoleteCount: number;
	durationMs: number;
	admissionClosed: boolean;
}

export async function processMediaUsageWorkAfterWrite(
	db: Kysely<Database>,
	collectionSlug: string,
	contentId: string,
): Promise<MediaUsageWorkProcessingResult> {
	if (!(await isIncrementalCaptureActive(db))) {
		return { outcome: "inactive", claimed: false };
	}

	const repo = new MediaUsageWorkRepository(db);
	const work = await repo.findWorkForContent(collectionSlug, contentId);
	if (!work) return { outcome: "not_due", claimed: false };
	return processCandidate(db, repo, work);
}

export async function processDueMediaUsageWork(
	db: Kysely<Database>,
): Promise<MediaUsageWorkTickResult> {
	const startedAt = Date.now();
	const result: MediaUsageWorkTickResult = {
		candidateCount: 0,
		claimedCount: 0,
		completedCount: 0,
		retryCount: 0,
		failedCount: 0,
		supersededCount: 0,
		obsoleteCount: 0,
		durationMs: 0,
		admissionClosed: false,
	};

	if (!(await isIncrementalCaptureActive(db))) {
		result.durationMs = Date.now() - startedAt;
		return result;
	}

	const repo = new MediaUsageWorkRepository(db);
	const candidates = await repo.findDueWork(MEDIA_USAGE_WORK_PROCESSING_LIMITS.candidatesPerTick);
	result.candidateCount = candidates.length;

	for (const candidate of candidates) {
		if (
			result.claimedCount >= MEDIA_USAGE_WORK_PROCESSING_LIMITS.jobsPerTick ||
			Date.now() - startedAt >= MEDIA_USAGE_WORK_PROCESSING_LIMITS.maxTickDurationMs
		) {
			result.admissionClosed = true;
			break;
		}

		const processed = await processCandidate(db, repo, candidate);
		if (processed.claimed) result.claimedCount++;
		if (processed.outcome === "completed") result.completedCount++;
		if (processed.outcome === "retry") result.retryCount++;
		if (processed.outcome === "failed") result.failedCount++;
		if (processed.outcome === "superseded") result.supersededCount++;
		if (processed.outcome === "obsolete") result.obsoleteCount++;
	}

	result.durationMs = Date.now() - startedAt;
	return result;
}

async function processCandidate(
	db: Kysely<Database>,
	repo: MediaUsageWorkRepository,
	candidate: MediaUsageWorkRecord,
): Promise<MediaUsageWorkProcessingResult> {
	const claimed = await repo.claimWork({
		collectionId: candidate.collectionId,
		contentId: candidate.contentId,
		workVersion: candidate.workVersion,
		leaseDurationSeconds: MEDIA_USAGE_WORK_PROCESSING_LIMITS.leaseDurationSeconds,
	});
	if (!claimed?.leaseToken) return { outcome: "claim_lost", claimed: false };

	const lease = {
		collectionId: claimed.collectionId,
		contentId: claimed.contentId,
		workVersion: claimed.workVersion,
		leaseToken: claimed.leaseToken,
	};
	if (!(await collectionIdentityIsCurrent(db, claimed.collectionId, claimed.collectionSlug))) {
		return {
			outcome: (await repo.completeWork(lease)) ? "obsolete" : "superseded",
			claimed: true,
		};
	}

	const refresh = await refreshContentMediaUsageForWork(
		db,
		claimed.collectionId,
		claimed.collectionSlug,
		claimed.contentId,
	);
	if (refresh.success) {
		const completed = await repo.completeWork(lease);
		if (completed) {
			await new MediaUsageRepository(db).recordIncrementalSuccess({
				collectionId: claimed.collectionId,
				collectionSlug: claimed.collectionSlug,
			});
		}
		return {
			outcome: completed ? "completed" : "superseded",
			claimed: true,
		};
	}

	if (!(await collectionIdentityIsCurrent(db, claimed.collectionId, claimed.collectionSlug))) {
		return {
			outcome: (await repo.completeWork(lease)) ? "obsolete" : "superseded",
			claimed: true,
		};
	}

	const errorCode = processingErrorCode(refresh.errorCode);
	const terminal =
		errorCode === "MEDIA_USAGE_RESOURCE_LIMIT" ||
		claimed.attemptCount + 1 >= MEDIA_USAGE_WORK_PROCESSING_LIMITS.maxAttempts;
	if (terminal) {
		const failed = await repo.failWork({ ...lease, errorCode });
		if (failed) {
			await new MediaUsageRepository(db).recordIncrementalFailure({
				collectionId: claimed.collectionId,
				collectionSlug: claimed.collectionSlug,
				contentId: claimed.contentId,
				workVersion: claimed.workVersion,
				errorCode,
			});
		}
		return {
			outcome: failed ? "failed" : "superseded",
			claimed: true,
		};
	}

	return {
		outcome: (await repo.retryWork({
			...lease,
			errorCode,
			retryDelaySeconds: retryDelaySeconds(claimed.attemptCount),
		}))
			? "retry"
			: "superseded",
		claimed: true,
	};
}

async function isIncrementalCaptureActive(db: Kysely<Database>): Promise<boolean> {
	const row = await db
		.selectFrom("_emdash_media_usage_activation")
		.select("state")
		.where("task_key", "=", "incremental_capture")
		.executeTakeFirst();
	return row?.state === "active";
}

async function collectionIdentityIsCurrent(
	db: Kysely<Database>,
	collectionId: string,
	collectionSlug: string,
): Promise<boolean> {
	const row = await db
		.selectFrom("_emdash_collections")
		.select("id")
		.where("id", "=", collectionId)
		.where("slug", "=", collectionSlug)
		.executeTakeFirst();
	return row !== undefined;
}

function retryDelaySeconds(attemptCount: number): number {
	const exponential = Math.min(
		MEDIA_USAGE_WORK_PROCESSING_LIMITS.retryMaxSeconds,
		MEDIA_USAGE_WORK_PROCESSING_LIMITS.retryBaseSeconds * 2 ** attemptCount,
	);
	const jitter = Math.floor(
		exponential * MEDIA_USAGE_WORK_PROCESSING_LIMITS.retryJitterRatio * Math.random(),
	);
	return Math.min(MEDIA_USAGE_WORK_PROCESSING_LIMITS.retryMaxSeconds, exponential + jitter);
}

function processingErrorCode(errorCode: ContentMediaUsageRefreshErrorCode | undefined): string {
	if (
		errorCode === "DRAFT_REVISION_NOT_FOUND" ||
		errorCode === "DRAFT_REVISION_MISMATCH" ||
		errorCode === "DRAFT_REVISION_INVALID"
	) {
		return "MEDIA_USAGE_SNAPSHOT_FAILED";
	}
	if (errorCode === "CONTENT_USAGE_GENERATION_CONFLICT") {
		return "MEDIA_USAGE_GENERATION_CONFLICT";
	}
	if (errorCode === "CONTENT_USAGE_RESOURCE_LIMIT") return "MEDIA_USAGE_RESOURCE_LIMIT";
	return "MEDIA_USAGE_PROCESSING_FAILED";
}
