import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import {
	MediaUsageRepository,
	type MediaUsageCleanupCandidate,
	type MediaUsageCleanupCursor,
} from "../../database/repositories/media-usage.js";
import type { Database } from "../../database/types.js";

export const MEDIA_USAGE_CLEANUP_CANDIDATE_LIMIT = 250;
export const MEDIA_USAGE_CLEANUP_DELETE_LIMIT = 50;
export const MEDIA_USAGE_CLEANUP_WRITE_LEASE_DELETE_LIMIT = 49;
export const MEDIA_USAGE_CLEANUP_INTERVAL_MS = 60 * 1000;
export const MEDIA_USAGE_CLEANUP_LEASE_MS = 5 * 60 * 1000;
export const MEDIA_USAGE_CLEANUP_SAFETY_WINDOW_MS = 60 * 60 * 1000;
const MEDIA_USAGE_CLEANUP_TIME_BUDGET_MS = 5 * 1000;

export interface MediaUsageCleanupResult {
	status: "completed" | "failed" | "skipped";
	candidateRows: number;
	deletedRows: number;
	deletedOrphans: number;
	deletedStale: number;
	deletedAbandoned: number;
	deletedWriteLeases: number;
	backlogLowerBound: number;
	scanHasMore: boolean;
	durationMs: number;
}

interface CleanupCandidates {
	orphanIds: string[];
	staleIds: string[];
	abandonedIds: string[];
	entries: CleanupCandidateEntry[];
}

type CleanupTarget = "orphan" | "stale" | "abandoned";

interface CleanupCandidateEntry {
	candidate: MediaUsageCleanupCandidate;
	target: CleanupTarget | null;
}

/**
 * Reclaims a bounded window of obsolete media-usage occurrences.
 *
 * The persisted claim makes a cron tick single-flight across Worker isolates
 * and Node processes.
 */
export async function cleanupMediaUsage(db: Kysely<Database>): Promise<MediaUsageCleanupResult> {
	const startedMs = Date.now();
	const canIssueStatement = () => withinBudget(startedMs);
	const repo = new MediaUsageRepository(db);
	const leaseToken = ulid();
	const claim = await repo.claimMediaUsageCleanup({
		leaseToken,
		leaseDurationSeconds: MEDIA_USAGE_CLEANUP_LEASE_MS / 1000,
		nextEligibleDelaySeconds: MEDIA_USAGE_CLEANUP_INTERVAL_MS / 1000,
		sweepSafetyWindowSeconds: MEDIA_USAGE_CLEANUP_SAFETY_WINDOW_MS / 1000,
	});
	if (!claim) return emptyResult("skipped", elapsedSince(startedMs));

	let candidateRows = 0;
	let deletedOrphans = 0;
	let deletedStale = 0;
	let deletedAbandoned = 0;
	let deletedWriteLeases = 0;
	let backlogLowerBound = 0;
	let scanHasMore = false;
	let nextCursor = claim.cursor;
	let sweepComplete = false;

	try {
		if (canIssueStatement()) {
			deletedWriteLeases = await repo.deleteExpiredGenerationWriteLeases(
				MEDIA_USAGE_CLEANUP_WRITE_LEASE_DELETE_LIMIT,
				cleanupLease(leaseToken),
				canIssueStatement,
			);
		}

		const cutoff = claim.scanBeforeAt;
		const candidates = await repo.findMediaUsageCleanupCandidates({
			cutoff,
			cursor: claim.cursor,
			limit: MEDIA_USAGE_CLEANUP_CANDIDATE_LIMIT,
			cleanupLease: cleanupLease(leaseToken),
			canIssueStatement,
		});
		if (candidates) {
			candidateRows = candidates.length;
			scanHasMore = candidates.length === MEDIA_USAGE_CLEANUP_CANDIDATE_LIMIT;

			const selected = selectCleanupCandidates(candidates, claim.claimedAt);
			backlogLowerBound =
				selected.orphanIds.length + selected.staleIds.length + selected.abandonedIds.length;
			const completedTargets = new Set<CleanupTarget>();
			let canContinue = true;

			if (canIssueStatement() && selected.orphanIds.length > 0) {
				deletedOrphans = await repo.deleteOrphanOccurrencesOlderThan(
					cutoff,
					selected.orphanIds.length,
					{
						candidateIds: selected.orphanIds,
						cleanupLease: cleanupLease(leaseToken),
						canIssueStatement,
					},
				);
				canContinue = deletedOrphans === selected.orphanIds.length;
				if (canContinue) completedTargets.add("orphan");
			}
			if (canContinue && canIssueStatement() && selected.staleIds.length > 0) {
				deletedStale = await repo.deleteStaleGenerationsOlderThan(
					cutoff,
					selected.staleIds.length,
					{
						candidateIds: selected.staleIds,
						cleanupLease: cleanupLease(leaseToken),
						canIssueStatement,
					},
				);
				canContinue = deletedStale === selected.staleIds.length;
				if (canContinue) completedTargets.add("stale");
			}
			if (canContinue && canIssueStatement() && selected.abandonedIds.length > 0) {
				deletedAbandoned = await repo.deleteAbandonedGenerationsOlderThan(
					cutoff,
					selected.abandonedIds.length,
					{
						candidateIds: selected.abandonedIds,
						cleanupLease: cleanupLease(leaseToken),
						canIssueStatement,
					},
				);
				if (deletedAbandoned === selected.abandonedIds.length) {
					completedTargets.add("abandoned");
				}
			}
			const hasIncompleteTargets = selected.entries.some(
				(entry) => entry.target !== null && !completedTargets.has(entry.target),
			);
			sweepComplete =
				!scanHasMore && selected.entries.length === candidates.length && !hasIncompleteTargets;
			nextCursor = sweepComplete
				? null
				: cursorAfterCompletedCandidates(selected, completedTargets, claim.cursor);
		}

		const durationMs = elapsedSince(startedMs);
		const completed = await repo.completeMediaUsageCleanup({
			leaseToken,
			nextCursor,
			sweepComplete,
			candidateCount: candidateRows,
			deletedOrphans,
			deletedStale,
			deletedAbandoned,
			deletedWriteLeases,
			backlogLowerBound,
			scanHasMore,
			durationMs,
		});

		return {
			status: completed ? "completed" : "skipped",
			candidateRows,
			deletedRows: deletedOrphans + deletedStale + deletedAbandoned,
			deletedOrphans,
			deletedStale,
			deletedAbandoned,
			deletedWriteLeases,
			backlogLowerBound,
			scanHasMore,
			durationMs,
		};
	} catch (error) {
		const durationMs = elapsedSince(startedMs);
		const failures = Math.min(claim.consecutiveFailures + 1, 5);
		try {
			await repo.failMediaUsageCleanup({
				leaseToken,
				retryDelaySeconds: failureDelayMs(failures) / 1000,
				consecutiveFailures: failures,
				durationMs,
				errorCode: "MEDIA_USAGE_CLEANUP_FAILED",
			});
		} catch (failureError) {
			console.error("[media-usage-cleanup] Failed to record cleanup failure:", failureError);
		}
		console.error("[media-usage-cleanup] Cleanup failed:", error);
		return {
			...emptyResult("failed", durationMs),
			candidateRows,
			deletedRows: deletedOrphans + deletedStale + deletedAbandoned,
			deletedOrphans,
			deletedStale,
			deletedAbandoned,
			deletedWriteLeases,
			backlogLowerBound,
			scanHasMore,
		};
	}
}

function selectCleanupCandidates(
	candidates: readonly MediaUsageCleanupCandidate[],
	activeLeaseAt: string,
): CleanupCandidates {
	const orphanIds: string[] = [];
	const staleIds: string[] = [];
	const abandonedIds: string[] = [];
	const entries: CleanupCandidateEntry[] = [];

	for (const candidate of candidates) {
		if (hasActiveWriteLease(candidate, activeLeaseAt)) {
			entries.push({ candidate, target: null });
			continue;
		}

		const target = cleanupTarget(candidate);
		if (target === null) {
			entries.push({ candidate, target: null });
			continue;
		}
		if (
			orphanIds.length + staleIds.length + abandonedIds.length >=
			MEDIA_USAGE_CLEANUP_DELETE_LIMIT
		) {
			break;
		}
		if (target === "orphan") orphanIds.push(candidate.id);
		if (target === "stale") staleIds.push(candidate.id);
		if (target === "abandoned") abandonedIds.push(candidate.id);
		entries.push({ candidate, target });
	}

	return { orphanIds, staleIds, abandonedIds, entries };
}

function cleanupTarget(candidate: MediaUsageCleanupCandidate): CleanupTarget | null {
	if (candidate.currentGeneration === null) return "orphan";
	if (candidate.currentGeneration === candidate.generation || candidate.indexedAt === null)
		return null;
	return candidate.createdAt < candidate.indexedAt ? "stale" : "abandoned";
}

function hasActiveWriteLease(
	candidate: MediaUsageCleanupCandidate,
	activeLeaseAt: string,
): boolean {
	return candidate.writeLeaseExpiresAt !== null && candidate.writeLeaseExpiresAt > activeLeaseAt;
}

function cursorFor(candidate: MediaUsageCleanupCandidate): MediaUsageCleanupCursor {
	return { createdAt: candidate.createdAt, id: candidate.id };
}

function cursorAfterCompletedCandidates(
	selected: CleanupCandidates,
	completedTargets: ReadonlySet<CleanupTarget>,
	priorCursor: MediaUsageCleanupCursor | null,
): MediaUsageCleanupCursor | null {
	let cursor = priorCursor;
	for (const entry of selected.entries) {
		if (entry.target !== null && !completedTargets.has(entry.target)) break;
		cursor = cursorFor(entry.candidate);
	}
	return cursor;
}

function emptyResult(
	status: Extract<MediaUsageCleanupResult["status"], "failed" | "skipped">,
	durationMs: number,
): MediaUsageCleanupResult {
	return {
		status,
		candidateRows: 0,
		deletedRows: 0,
		deletedOrphans: 0,
		deletedStale: 0,
		deletedAbandoned: 0,
		deletedWriteLeases: 0,
		backlogLowerBound: 0,
		scanHasMore: false,
		durationMs,
	};
}

function withinBudget(startedMs: number): boolean {
	return elapsedSince(startedMs) < MEDIA_USAGE_CLEANUP_TIME_BUDGET_MS;
}

function elapsedSince(startedMs: number): number {
	return Math.max(0, Date.now() - startedMs);
}

function failureDelayMs(consecutiveFailures: number): number {
	return Math.min(2 ** (consecutiveFailures - 1), 15) * MEDIA_USAGE_CLEANUP_INTERVAL_MS;
}

function cleanupLease(leaseToken: string) {
	return { leaseToken };
}
