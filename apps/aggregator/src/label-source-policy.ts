import { labelSourceHealthInstant } from "./label-source-health.js";
import type { ListingPolicyConfig } from "./listing-policy.js";

export interface LabelSourcePolicy {
	requiredPositiveSources: readonly string[];
	acceptedStateSources: readonly string[];
	redactionSources: readonly string[];
	acceptedSources: ReadonlySet<string>;
	policyVersion: string;
}

export function labelSourcePolicy(policy: ListingPolicyConfig): LabelSourcePolicy {
	const requiredPositiveSources = policy.requiredPositiveSources;
	const acceptedStateSources = policy.acceptedStateSources;
	const redactionSources = policy.redactionSources;
	return {
		requiredPositiveSources,
		acceptedStateSources,
		redactionSources,
		acceptedSources: new Set([
			...requiredPositiveSources,
			...acceptedStateSources,
			...redactionSources,
		]),
		policyVersion: policy.moderationPolicyVersion,
	};
}

export interface ReconcileLabelSourcesResult {
	changed: boolean;
	activeSources: readonly string[];
	sourcesRequiringStop: readonly string[];
}

export async function reconcileLabelSources(
	db: D1Database,
	policy: LabelSourcePolicy,
): Promise<ReconcileLabelSourcesResult> {
	const rows = await db
		.prepare(
			`SELECT did, active, required_positive, accepted_state, redaction, policy_version,
			        stop_acknowledged
			 FROM labellers`,
		)
		.all<{
			did: string;
			active: number;
			required_positive: number;
			accepted_state: number;
			redaction: number;
			policy_version: string;
			stop_acknowledged: number;
		}>();
	const existing = new Map((rows.results ?? []).map((row) => [row.did, row]));
	const statements: D1PreparedStatement[] = [];
	const sourcesRequiringStop: string[] = [];
	let changed = false;

	for (const did of policy.acceptedSources) {
		const desired = {
			required: policy.requiredPositiveSources.includes(did) ? 1 : 0,
			state: policy.acceptedStateSources.includes(did) ? 1 : 0,
			redaction: policy.redactionSources.includes(did) ? 1 : 0,
		};
		const current = existing.get(did);
		if (
			current?.active !== 1 ||
			current.required_positive !== desired.required ||
			current.accepted_state !== desired.state ||
			current.redaction !== desired.redaction ||
			current.policy_version !== policy.policyVersion
		) {
			changed = true;
		}
		statements.push(
			db
				.prepare(
					`INSERT INTO labellers
					   (did, endpoint, signing_key, signing_key_id, trusted, added_at,
					    last_resolved_at, active, required_positive, accepted_state,
					    redaction, policy_version, replay_pending, replay_generation)
					 VALUES (?, '', '', ?, 0, datetime('now'), '1970-01-01T00:00:00.000Z',
					         1, ?, ?, ?, ?, 1, 1)
					 ON CONFLICT(did) DO UPDATE SET
					   trusted = CASE
					     WHEN labellers.active = 1 THEN labellers.trusted ELSE 0 END,
					   replay_pending = CASE
					     WHEN labellers.active = 1 THEN labellers.replay_pending ELSE 1 END,
					   replay_generation = CASE
					     WHEN labellers.active = 1 THEN labellers.replay_generation
					     ELSE labellers.replay_generation + 1 END,
					   active = 1,
					   required_positive = excluded.required_positive,
					   accepted_state = excluded.accepted_state,
					   redaction = excluded.redaction,
					   policy_version = excluded.policy_version,
					   stop_acknowledged = 0`,
				)
				.bind(
					did,
					`${did}#atproto_label`,
					desired.required,
					desired.state,
					desired.redaction,
					policy.policyVersion,
				),
			db
				.prepare(
					`UPDATE label_state
					 SET trusted = (SELECT source.trusted FROM labellers source WHERE source.did = ?)
					 WHERE src = ?
					   AND trusted <> (SELECT source.trusted FROM labellers source WHERE source.did = ?)`,
				)
				.bind(did, did, did),
		);
	}

	for (const row of existing.values()) {
		if (policy.acceptedSources.has(row.did)) continue;
		if (row.active === 1) {
			changed = true;
			statements.push(
				db
					.prepare(
						`UPDATE labellers SET trusted = 0, active = 0, replay_pending = 0,
						 required_positive = 0, accepted_state = 0, redaction = 0,
						 policy_version = ?, stop_acknowledged = 0 WHERE did = ?`,
					)
					.bind(policy.policyVersion, row.did),
				db
					.prepare(`UPDATE label_state SET trusted = 0 WHERE src = ? AND trusted = 1`)
					.bind(row.did),
			);
		}
		if (row.active === 1 || row.stop_acknowledged !== 1) sourcesRequiringStop.push(row.did);
	}

	if (statements.length > 0) await db.batch(statements);
	return { changed, activeSources: [...policy.acceptedSources], sourcesRequiringStop };
}

export async function readLabelSourceTrust(db: D1Database, did: string): Promise<boolean> {
	const row = await db
		.prepare(`SELECT active, trusted FROM labellers WHERE did = ?`)
		.bind(did)
		.first<{ active: number; trusted: number }>();
	if (!row || row.active !== 1) throw new Error(`labeler is not configured: ${did}`);
	return row.trusted === 1;
}

export async function activateLabelSourceAfterReplay(
	db: D1Database,
	did: string,
	policyVersion: string,
	replayGeneration: number,
	activatedAt: Date,
): Promise<boolean> {
	if (!Number.isSafeInteger(replayGeneration) || replayGeneration < 0) {
		throw new TypeError("label source replay generation is invalid");
	}
	const instant = labelSourceHealthInstant(activatedAt);
	await db.batch([
		db
			.prepare(
				`UPDATE labellers SET
				   trusted = 1,
				   replay_pending = 0,
				   health_last_success_at = ?,
				   health_last_success_epoch = ?,
				   health_failure_started_at = NULL,
				   health_failure_started_epoch = NULL,
				   health_failure_count = 0
				 WHERE did = ? AND active = 1 AND policy_version = ?
				   AND replay_generation = ?`,
			)
			.bind(instant.iso, instant.epoch, did, policyVersion, replayGeneration),
		db
			.prepare(
				`UPDATE label_state SET trusted = 1
				 WHERE src = ? AND trusted <> 1
				   AND EXISTS (
				     SELECT 1 FROM labellers source
				     WHERE source.did = ? AND source.active = 1 AND source.trusted = 1
				       AND source.policy_version = ? AND source.replay_generation = ?
				   )`,
			)
			.bind(did, did, policyVersion, replayGeneration),
	]);
	const row = await db
		.prepare(
			`SELECT 1 AS active FROM labellers
			 WHERE did = ? AND active = 1 AND trusted = 1 AND policy_version = ?
			   AND replay_generation = ? AND replay_pending = 0`,
		)
		.bind(did, policyVersion, replayGeneration)
		.first<{ active: number }>();
	return row !== null;
}

export async function acknowledgeLabelSourceStop(db: D1Database, did: string): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE labellers SET stop_acknowledged = 1
			 WHERE did = ? AND active = 0 AND trusted = 0`,
		)
		.bind(did)
		.run();
	return result.meta.changes === 1;
}
