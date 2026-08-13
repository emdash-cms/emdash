import type { Kysely } from "kysely";

import { MediaUsageWorkRepository } from "../../database/repositories/media-usage-work.js";
import type { Database } from "../../database/types.js";
import {
	buildContentMediaUsageFieldFingerprint,
	loadContentMediaUsageFields,
} from "./content-fields.js";
import {
	MediaUsageReconciliationRepository,
	type MediaUsageReconciliationClaim,
	type MediaUsageReconciliationRecord,
} from "./reconciliation.js";
import { CONTENT_SOURCE_SCHEMA_VERSION } from "./types.js";

export const MEDIA_USAGE_RECONCILIATION_LIMITS = Object.freeze({
	candidatesPerTick: 4,
	pageSize: 50,
	leaseDurationSeconds: 60,
	maxAttempts: 5,
	retryBaseSeconds: 30,
	retryMaxSeconds: 15 * 60,
	retryJitterRatio: 0.25,
	maxQueriesPerTick: 20,
});

export type MediaUsageReconciliationOutcome =
	| "inactive"
	| "not_due"
	| "claim_lost"
	| "advanced"
	| "deferred"
	| "completed"
	| "retry"
	| "failed";

export type MediaUsageReconciliationScanOutcome =
	| "advanced"
	| "exhausted"
	| "deferred"
	| "restart_required";

export async function processDueMediaUsageReconciliation(
	db: Kysely<Database>,
): Promise<MediaUsageReconciliationOutcome> {
	const activation = await db
		.selectFrom("_emdash_media_usage_activation")
		.select("state")
		.where("task_key", "=", "incremental_capture")
		.executeTakeFirst();
	if (activation?.state !== "active") return "inactive";

	const reconciliation = new MediaUsageReconciliationRepository(db);
	if (await reconciliation.deleteOneObsolete()) return "completed";
	const [failed] = await reconciliation.findFailed(1);
	if (failed) {
		if (await reconciliation.finishFailedCoverage(failed.collectionId, failed.runToken)) {
			return "failed";
		}
		if (await reconciliation.resetFailedForNewEpoch(failed)) return "advanced";
	}

	await reconciliation.seedNextCandidate();
	const candidates = await reconciliation.findDue(
		MEDIA_USAGE_RECONCILIATION_LIMITS.candidatesPerTick,
	);
	let claim: MediaUsageReconciliationClaim | null = null;
	for (const candidate of candidates) {
		claim = await reconciliation.claim({
			collectionId: candidate.collectionId,
			runToken: candidate.runToken,
			leaseDurationSeconds: MEDIA_USAGE_RECONCILIATION_LIMITS.leaseDurationSeconds,
		});
		if (claim) break;
	}
	if (!claim) return candidates.length === 0 ? "not_due" : "claim_lost";

	try {
		return await processClaimedReconciliation(db, claim);
	} catch (error) {
		const terminal = claim.attemptCount + 1 >= MEDIA_USAGE_RECONCILIATION_LIMITS.maxAttempts;
		const recorded = await reconciliation.recordFailure({
			collectionId: claim.collectionId,
			runToken: claim.runToken,
			leaseToken: claim.leaseToken,
			errorCode: "MEDIA_USAGE_RECONCILIATION_FAILED",
			retryDelaySeconds: retryDelaySeconds(claim.attemptCount),
			terminal,
		});
		if (!recorded) return "claim_lost";
		if (terminal) await reconciliation.finishFailedCoverage(claim.collectionId, claim.runToken);
		console.error("[media-usage:reconciliation] Processing failed:", error);
		return terminal ? "failed" : "retry";
	}
}

export async function processClaimedMediaUsageReconciliationScan(
	db: Kysely<Database>,
	claim: MediaUsageReconciliationClaim,
	options: { releaseOnExhausted?: boolean } = {},
): Promise<MediaUsageReconciliationScanOutcome> {
	const reconciliation = new MediaUsageReconciliationRepository(db);
	let current = await reconciliation.findByIdentity(claim.collectionId, claim.runToken);
	if (!current || current.leaseToken !== claim.leaseToken || current.phase !== "scan") {
		return "deferred";
	}

	let fields;
	let fieldFingerprint: string;
	if (current.targetEpoch === null) {
		const targetEpoch = await reconciliation.beginRun(claim);
		if (targetEpoch === null) {
			await reconciliation.release({ ...claim, delaySeconds: 30 });
			return "deferred";
		}
		fields = await loadContentMediaUsageFields(db, claim.collectionSlug, claim.collectionId);
		fieldFingerprint = await buildContentMediaUsageFieldFingerprint(fields);
		const scanUpperId =
			fields.extractionFields.length === 0 ? null : await reconciliation.findScanUpperId(claim);
		if (
			!(await reconciliation.initializeScan({
				claim,
				targetEpoch,
				fieldFingerprint,
				scanUpperId,
			}))
		) {
			return "deferred";
		}
		current = await reconciliation.findByIdentity(claim.collectionId, claim.runToken);
		if (!current) return "deferred";
	} else {
		fields = await loadContentMediaUsageFields(db, claim.collectionSlug, claim.collectionId);
		fieldFingerprint = await buildContentMediaUsageFieldFingerprint(fields);
	}

	if (current.fieldFingerprint !== fieldFingerprint || current.targetEpoch === null) {
		return "restart_required";
	}
	const contentIds = await reconciliation.findScanPage(current, 50);
	if (contentIds.length === 0) {
		if (options.releaseOnExhausted ?? true) {
			await reconciliation.release({ ...claim, delaySeconds: 30 });
		}
		return "exhausted";
	}

	const work = new MediaUsageWorkRepository(db);
	await work.enqueueReconciliationPage({
		collectionId: claim.collectionId,
		collectionSlug: claim.collectionSlug,
		runToken: claim.runToken,
		leaseToken: claim.leaseToken,
		changeEpoch: current.targetEpoch,
		phase: "scan",
		contentIds,
	});
	const nextCursor = contentIds.at(-1)!;
	if (
		!(await reconciliation.checkpointScan({
			claim,
			targetEpoch: current.targetEpoch,
			previousCursor: current.scanCursor,
			nextCursor,
		}))
	) {
		return "deferred";
	}
	if (!(await reconciliation.release({ ...claim, delaySeconds: 0 }))) return "deferred";
	return "advanced";
}

async function processClaimedReconciliation(
	db: Kysely<Database>,
	claim: MediaUsageReconciliationClaim,
): Promise<MediaUsageReconciliationOutcome> {
	const reconciliation = new MediaUsageReconciliationRepository(db);
	let current = await reconciliation.findByIdentity(claim.collectionId, claim.runToken);
	if (!current || current.leaseToken !== claim.leaseToken) return "claim_lost";
	if (current.targetEpoch !== null && !(await reconciliation.ownsRun(claim, current.targetEpoch))) {
		return restartReconciliation(db, reconciliation, claim, current);
	}

	if (current.phase === "scan") {
		const outcome = await processClaimedMediaUsageReconciliationScan(db, claim, {
			releaseOnExhausted: false,
		});
		if (outcome === "restart_required") {
			current =
				(await reconciliation.findByIdentity(claim.collectionId, claim.runToken)) ?? current;
			return restartReconciliation(db, reconciliation, claim, current);
		}
		if (outcome !== "exhausted") return outcome;
		current = (await reconciliation.findByIdentity(claim.collectionId, claim.runToken)) ?? current;
		const barrier = await reconciliation.findWorkBarrier(claim.collectionId);
		if (barrier.state === "failed") {
			return failReconciliation(reconciliation, claim, barrier.errorCode, true);
		}
		if (barrier.state === "pending") {
			await reconciliation.release({ ...claim, delaySeconds: 30 });
			return "deferred";
		}
		if (current.targetEpoch === null || current.fieldFingerprint === null) return "claim_lost";
		const sourceUpperKey = await reconciliation.findSourceUpperKey(claim, current.targetEpoch);
		if (
			!(await reconciliation.transitionToSources({
				claim,
				targetEpoch: current.targetEpoch,
				fieldFingerprint: current.fieldFingerprint,
				sourceUpperKey,
			}))
		) {
			return "claim_lost";
		}
		if (!(await reconciliation.release({ ...claim, delaySeconds: 0 }))) return "claim_lost";
		return "advanced";
	}

	return processSourcePhase(db, reconciliation, claim, current);
}

async function processSourcePhase(
	db: Kysely<Database>,
	reconciliation: MediaUsageReconciliationRepository,
	claim: MediaUsageReconciliationClaim,
	current: MediaUsageReconciliationRecord,
): Promise<MediaUsageReconciliationOutcome> {
	if (current.targetEpoch === null || current.fieldFingerprint === null) return "claim_lost";
	const fields = await loadContentMediaUsageFields(db, claim.collectionSlug, claim.collectionId);
	const fieldFingerprint = await buildContentMediaUsageFieldFingerprint(fields);
	if (fieldFingerprint !== current.fieldFingerprint) {
		return restartReconciliation(db, reconciliation, claim, current, fields, fieldFingerprint);
	}

	const page = await reconciliation.findSourcePage(
		current,
		MEDIA_USAGE_RECONCILIATION_LIMITS.pageSize,
	);
	if (page.length > 0) {
		const malformed = page.some(
			(source) =>
				!source.contentId ||
				(source.sourceVariant !== "columns" && source.sourceVariant !== "draft_overlay"),
		);
		if (malformed) {
			return failReconciliation(
				reconciliation,
				claim,
				"MEDIA_USAGE_RECONCILIATION_INVALID_SOURCE",
				false,
			);
		}
		const contentIds = [...new Set(page.map((source) => source.contentId!))];
		const enqueueIds =
			fields.extractionFields.length === 0
				? contentIds
				: await reconciliation.findMissingContentIds(claim.collectionSlug, contentIds);
		if (enqueueIds.length > 0) {
			await new MediaUsageWorkRepository(db).enqueueReconciliationPage({
				collectionId: claim.collectionId,
				collectionSlug: claim.collectionSlug,
				runToken: claim.runToken,
				leaseToken: claim.leaseToken,
				changeEpoch: current.targetEpoch,
				phase: "sources",
				contentIds: enqueueIds,
			});
		}
		if (
			!(await reconciliation.checkpointSources({
				claim,
				targetEpoch: current.targetEpoch,
				previousCursor: current.sourceCursor,
				nextCursor: page.at(-1)!.sourceKey,
			}))
		) {
			return "claim_lost";
		}
		if (!(await reconciliation.release({ ...claim, delaySeconds: 0 }))) return "claim_lost";
		return "advanced";
	}

	const barrier = await reconciliation.findWorkBarrier(claim.collectionId);
	if (barrier.state === "failed") {
		return failReconciliation(reconciliation, claim, barrier.errorCode, true);
	}
	if (barrier.state === "pending") {
		await reconciliation.release({ ...claim, delaySeconds: 30 });
		return "deferred";
	}
	if (
		!(await reconciliation.finalizeCoverage({
			claim,
			targetEpoch: current.targetEpoch,
			fieldFingerprint,
			schemaVersion: CONTENT_SOURCE_SCHEMA_VERSION,
		}))
	) {
		return "claim_lost";
	}
	if (!(await reconciliation.deleteFinalized(claim))) return "claim_lost";
	return "completed";
}

async function restartReconciliation(
	db: Kysely<Database>,
	reconciliation: MediaUsageReconciliationRepository,
	claim: MediaUsageReconciliationClaim,
	current: MediaUsageReconciliationRecord,
	fields?: Awaited<ReturnType<typeof loadContentMediaUsageFields>>,
	fieldFingerprint?: string,
): Promise<MediaUsageReconciliationOutcome> {
	if (current.targetEpoch === null) return "claim_lost";
	const discoveredFields =
		fields ?? (await loadContentMediaUsageFields(db, claim.collectionSlug, claim.collectionId));
	const fingerprint =
		fieldFingerprint ?? (await buildContentMediaUsageFieldFingerprint(discoveredFields));
	const targetEpoch = await reconciliation.restartRun(claim, current.targetEpoch);
	if (targetEpoch === null) {
		await reconciliation.release({ ...claim, delaySeconds: 30 });
		return "deferred";
	}
	const scanUpperId =
		discoveredFields.extractionFields.length === 0
			? null
			: await reconciliation.findScanUpperId(claim);
	if (
		!(await reconciliation.restartScan({
			claim,
			previousEpoch: current.targetEpoch,
			targetEpoch,
			fieldFingerprint: fingerprint,
			scanUpperId,
		}))
	) {
		return "claim_lost";
	}
	if (!(await reconciliation.release({ ...claim, delaySeconds: 0 }))) return "claim_lost";
	return "advanced";
}

async function failReconciliation(
	reconciliation: MediaUsageReconciliationRepository,
	claim: MediaUsageReconciliationClaim,
	errorCode: string,
	entryFailure: boolean,
): Promise<MediaUsageReconciliationOutcome> {
	const recorded = entryFailure
		? await reconciliation.recordEntryFailure(claim)
		: await reconciliation.recordFailure({
				collectionId: claim.collectionId,
				runToken: claim.runToken,
				leaseToken: claim.leaseToken,
				errorCode,
				retryDelaySeconds: 0,
				terminal: true,
			});
	if (!recorded) return "claim_lost";
	await reconciliation.finishFailedCoverage(claim.collectionId, claim.runToken);
	return "failed";
}

function retryDelaySeconds(attemptCount: number): number {
	const exponential = Math.min(
		MEDIA_USAGE_RECONCILIATION_LIMITS.retryMaxSeconds,
		MEDIA_USAGE_RECONCILIATION_LIMITS.retryBaseSeconds * 2 ** attemptCount,
	);
	const jitter = Math.floor(
		exponential * MEDIA_USAGE_RECONCILIATION_LIMITS.retryJitterRatio * Math.random(),
	);
	return Math.min(MEDIA_USAGE_RECONCILIATION_LIMITS.retryMaxSeconds, exponential + jitter);
}
