import { NSID } from "@emdash-cms/registry-lexicons";

import { createProductionDidResolver, type DidResolver } from "./did-resolver.js";
import type { RecordsJob } from "./env.js";
import { getListingPolicy } from "./listing-policy.js";
import {
	fetchAndVerifyRecord,
	isTransient,
	PdsVerificationError,
	type VerifiedPdsRecord,
} from "./pds-verify.js";
import {
	rebuildPublicProjection,
	type RebuildPublicProjectionResult,
} from "./public-projection.js";
import { IngestError, ingestPackageProfile } from "./records-consumer.js";
import { boundFetch } from "./utils.js";

interface PendingProfile {
	did: string;
	slug: string;
	current_cid: string | null;
}

type VerifyProfile = (options: {
	pds: string;
	did: string;
	collection: string;
	rkey: string;
	publicKey: Awaited<ReturnType<DidResolver["resolve"]>>["publicKey"];
	fetch?: typeof fetch;
}) => Promise<VerifiedPdsRecord>;

export interface ProfileInstallabilityReconciliationDeps {
	db: D1Database;
	resolver: Pick<DidResolver, "resolve">;
	verify: VerifyProfile;
	fetch?: typeof fetch;
	now: () => Date;
	activateProjection: () => Promise<RebuildPublicProjectionResult>;
	concurrency?: number;
}

export interface ProfileInstallabilityReconciliationResult {
	status: "complete" | "retryable";
	processed: number;
	valid: number;
	invalid: number;
	pending: number;
	projection: RebuildPublicProjectionResult | null;
}

type ProfileResult = "valid" | "invalid" | "pending" | "superseded";

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;

export function createProfileInstallabilityReconciliationDeps(
	env: Env,
): ProfileInstallabilityReconciliationDeps {
	return {
		db: env.DB,
		resolver: createProductionDidResolver(env),
		verify: fetchAndVerifyRecord,
		fetch: boundFetch,
		now: () => new Date(),
		activateProjection: async () =>
			rebuildPublicProjection(env.DB, {
				listingPolicy: await getListingPolicy(env),
				evaluatedAt: new Date(),
			}),
	};
}

export async function reconcileProfileInstallability(
	deps: ProfileInstallabilityReconciliationDeps,
): Promise<ProfileInstallabilityReconciliationResult> {
	const state = await deps.db
		.prepare("SELECT status FROM profile_installability_reconciliation WHERE id = 1")
		.first<{ status: "pending" | "complete" }>();
	if (!state) throw new Error("profile installability reconciliation state is missing");
	if (state.status === "complete") return completedNoOp();

	const candidates = await readPendingProfiles(deps.db);
	const results = await mapConcurrent(
		candidates,
		deps.concurrency ?? DEFAULT_CONCURRENCY,
		(candidate) => reconcileProfile(candidate, deps),
	);
	const pending = await countPendingProfiles(deps.db);
	const valid = results.filter((result) => result === "valid").length;
	const invalid = results.filter((result) => result === "invalid").length;
	if (pending > 0) {
		return {
			status: "retryable",
			processed: candidates.length,
			valid,
			invalid,
			pending,
			projection: null,
		};
	}

	const projection = await deps.activateProjection();
	const completedAt = deps.now().toISOString();
	const completion = await deps.db
		.prepare(
			`UPDATE profile_installability_reconciliation
			 SET status = 'complete', completed_at = ?
			 WHERE id = 1 AND status = 'pending'
			   AND NOT EXISTS (
			     SELECT 1
			     FROM packages p
			     LEFT JOIN package_profile_heads h ON h.did = p.did AND h.slug = p.slug
			     LEFT JOIN package_profile_revisions r
			       ON r.did = h.did AND r.slug = h.slug AND r.cid = h.current_cid
			     WHERE (h.did IS NULL AND p.installability_status = 'pending')
			        OR (h.deleted_at IS NULL AND r.installability_status = 'pending')
			   )`,
		)
		.bind(completedAt)
		.run();
	if (completion.meta.changes !== 1) {
		return {
			status: "retryable",
			processed: candidates.length,
			valid,
			invalid,
			pending: await countPendingProfiles(deps.db),
			projection,
		};
	}

	return {
		status: "complete",
		processed: candidates.length,
		valid,
		invalid,
		pending: 0,
		projection,
	};
}

async function reconcileProfile(
	candidate: PendingProfile,
	deps: ProfileInstallabilityReconciliationDeps,
): Promise<ProfileResult> {
	try {
		const resolved = await deps.resolver.resolve(candidate.did);
		const verified = await deps.verify({
			pds: resolved.pds,
			did: candidate.did,
			collection: NSID.packageProfile,
			rkey: candidate.slug,
			publicKey: resolved.publicKey,
			fetch: deps.fetch,
		});
		const job: RecordsJob = {
			did: candidate.did,
			collection: NSID.packageProfile,
			rkey: candidate.slug,
			operation: "update",
			cid: verified.cid,
			source: "backfill",
		};
		const installability = await ingestPackageProfile(deps.db, job, verified, deps.now());
		return installability.status;
	} catch (error) {
		if (error instanceof PdsVerificationError) {
			if (isTransient(error.reason, error.status)) return "pending";
			return (await markCurrentProfileInvalid(
				deps.db,
				candidate,
				pdsFailureReason(error),
				deps.now(),
			))
				? "invalid"
				: "superseded";
		}
		if (error instanceof IngestError) {
			return (await markCurrentProfileInvalid(
				deps.db,
				candidate,
				"PROFILE_RECORD_INVALID",
				deps.now(),
			))
				? "invalid"
				: "superseded";
		}
		console.error("[aggregator] profile installability reconciliation failed", {
			did: candidate.did,
			slug: candidate.slug,
			error: error instanceof Error ? error.message : String(error),
		});
		return "pending";
	}
}

async function readPendingProfiles(db: D1Database): Promise<PendingProfile[]> {
	const rows = await db
		.prepare(
			`SELECT p.did, p.slug, h.current_cid
			 FROM packages p
			 LEFT JOIN package_profile_heads h ON h.did = p.did AND h.slug = p.slug
			 LEFT JOIN package_profile_revisions r
			   ON r.did = h.did AND r.slug = h.slug AND r.cid = h.current_cid
			 WHERE (h.did IS NULL AND p.installability_status = 'pending')
			    OR (h.deleted_at IS NULL AND r.installability_status = 'pending')
			 ORDER BY p.did, p.slug`,
		)
		.all<PendingProfile>();
	return rows.results;
}

async function countPendingProfiles(db: D1Database): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count
			 FROM packages p
			 LEFT JOIN package_profile_heads h ON h.did = p.did AND h.slug = p.slug
			 LEFT JOIN package_profile_revisions r
			   ON r.did = h.did AND r.slug = h.slug AND r.cid = h.current_cid
			 WHERE (h.did IS NULL AND p.installability_status = 'pending')
			    OR (h.deleted_at IS NULL AND r.installability_status = 'pending')`,
		)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

async function markCurrentProfileInvalid(
	db: D1Database,
	candidate: PendingProfile,
	reason: string,
	now: Date,
): Promise<boolean> {
	const current = db
		.prepare(
			`UPDATE packages
			 SET emdash_extension = NULL,
			     installability_status = 'invalid',
			     installability_error = ?,
			     verified_at = ?
			 WHERE did = ? AND slug = ?
			   AND (
			     (? IS NULL AND NOT EXISTS (
			       SELECT 1 FROM package_profile_heads h
			       WHERE h.did = packages.did AND h.slug = packages.slug
			     ))
			     OR EXISTS (
			     SELECT 1 FROM package_profile_heads h
			     WHERE h.did = packages.did
			       AND h.slug = packages.slug
			       AND h.current_cid = ?
			       AND h.deleted_at IS NULL
			     )
			   )`,
		)
		.bind(
			reason,
			now.toISOString(),
			candidate.did,
			candidate.slug,
			candidate.current_cid,
			candidate.current_cid,
		);
	if (candidate.current_cid === null) {
		const currentResult = await current.run();
		return currentResult.meta.changes === 1;
	}
	const revision = db
		.prepare(
			`UPDATE package_profile_revisions
			 SET emdash_extension = NULL,
			     installability_status = 'invalid',
			     installability_error = ?,
			     last_verified_at = ?
			 WHERE did = ? AND slug = ? AND cid = ?
			   AND installability_status = 'pending'
			   AND EXISTS (
			     SELECT 1 FROM package_profile_heads h
			     WHERE h.did = package_profile_revisions.did
			       AND h.slug = package_profile_revisions.slug
			       AND h.current_cid = package_profile_revisions.cid
			       AND h.deleted_at IS NULL
			   )`,
		)
		.bind(reason, now.toISOString(), candidate.did, candidate.slug, candidate.current_cid);
	const [revisionResult, currentResult] = await db.batch([revision, current]);
	return revisionResult?.meta.changes === 1 && currentResult?.meta.changes === 1;
}

function pdsFailureReason(error: PdsVerificationError): string {
	switch (error.reason) {
		case "RECORD_NOT_FOUND":
			return "PROFILE_RECORD_NOT_FOUND";
		case "RESPONSE_TOO_LARGE":
			return "PROFILE_RESPONSE_TOO_LARGE";
		case "INVALID_PROOF":
			return "PROFILE_PROOF_INVALID";
		case "PDS_HTTP_ERROR":
			return "PROFILE_PDS_HTTP_ERROR";
		case "PDS_NETWORK_ERROR":
			throw new Error("transient PDS network errors cannot be marked invalid");
	}
}

async function mapConcurrent<T, R>(
	items: readonly T[],
	requestedConcurrency: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];
	const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(requestedConcurrency)));
	const results: R[] = [];
	results.length = items.length;
	let cursor = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		for (;;) {
			const index = cursor++;
			const item = items[index];
			if (item === undefined) return;
			results[index] = await fn(item);
		}
	});
	await Promise.all(workers);
	return results;
}

function completedNoOp(): ProfileInstallabilityReconciliationResult {
	return {
		status: "complete",
		processed: 0,
		valid: 0,
		invalid: 0,
		pending: 0,
		projection: null,
	};
}
