// Two scheduled-maintenance intervals and twice the labeler identity TTL.
// A healthy idle subscription therefore gets a reconnect/catch-up opportunity
// before its authority is withdrawn at the exact boundary.
export const REQUIRED_LABEL_SOURCE_HEALTH_TIMEOUT_MS = 10 * 60 * 1_000;

interface HealthInstant {
	iso: string;
	epoch: number;
}

export function labelSourceHealthInstant(value: Date): HealthInstant {
	const epoch = value.getTime();
	if (!Number.isSafeInteger(epoch)) throw new TypeError("label source health time is invalid");
	return { iso: value.toISOString(), epoch };
}

function healthTimeout(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new TypeError("label source health timeout is invalid");
	}
	return value;
}

export async function stageLabelSourceReplay(
	db: D1Database,
	did: string,
	observedAt: Date,
): Promise<boolean> {
	labelSourceHealthInstant(observedAt);
	await db.batch([
		db
			.prepare(
				`UPDATE labellers SET
				   trusted = 0,
				   replay_generation = replay_generation + 1,
				   replay_pending = 1,
				   health_last_success_at = NULL,
				   health_last_success_epoch = NULL,
				   health_failure_started_at = NULL,
				   health_failure_started_epoch = NULL,
				   health_failure_count = 0
				 WHERE did = ? AND active = 1`,
			)
			.bind(did),
		db
			.prepare(
				`UPDATE label_state SET trusted = 0
				 WHERE src = ? AND trusted <> 0
				   AND EXISTS (
				     SELECT 1 FROM labellers source
				     WHERE source.did = ? AND source.active = 1 AND source.replay_pending = 1
				   )`,
			)
			.bind(did, did),
		db
			.prepare(
				`DELETE FROM ingest_state
				 WHERE source = ?
				   AND EXISTS (
				     SELECT 1 FROM labellers configured
				     WHERE configured.did = ? AND configured.active = 1
				       AND configured.replay_pending = 1
				   )`,
			)
			.bind(`labeler:${did}`, did),
	]);
	const staged = await db
		.prepare(
			`SELECT 1 AS staged FROM labellers
			 WHERE did = ? AND active = 1 AND trusted = 0 AND replay_pending = 1`,
		)
		.bind(did)
		.first<{ staged: number }>();
	return staged !== null;
}

export async function markLabelSourceHealthy(
	db: D1Database,
	did: string,
	observedAt: Date,
): Promise<void> {
	const instant = labelSourceHealthInstant(observedAt);
	await db
		.prepare(
			`UPDATE labellers SET
			   health_last_success_at = CASE
			     WHEN health_last_success_epoch IS NULL OR health_last_success_epoch <= ?
			     THEN ? ELSE health_last_success_at END,
			   health_last_success_epoch = CASE
			     WHEN health_last_success_epoch IS NULL OR health_last_success_epoch <= ?
			     THEN ? ELSE health_last_success_epoch END,
			   health_failure_started_at = NULL,
			   health_failure_started_epoch = NULL,
			   health_failure_count = 0
			 WHERE did = ? AND active = 1`,
		)
		.bind(instant.epoch, instant.iso, instant.epoch, instant.epoch, did)
		.run();
}

export async function markLabelSourceFailure(
	db: D1Database,
	did: string,
	observedAt: Date,
	timeoutMs = REQUIRED_LABEL_SOURCE_HEALTH_TIMEOUT_MS,
): Promise<boolean> {
	const instant = labelSourceHealthInstant(observedAt);
	const timeout = healthTimeout(timeoutMs);
	const results = await db.batch([
		db
			.prepare(
				`UPDATE labellers SET
				   health_failure_started_at = COALESCE(health_failure_started_at, ?),
				   health_failure_started_epoch = COALESCE(health_failure_started_epoch, ?),
				   health_failure_count = health_failure_count + 1
				 WHERE did = ? AND active = 1`,
			)
			.bind(instant.iso, instant.epoch, did),
		db
			.prepare(
				`UPDATE labellers SET
				   trusted = 0,
				   replay_pending = 1,
				   replay_generation = replay_generation + 1
				 WHERE did = ? AND active = 1 AND trusted = 1
				   AND (required_positive = 1 OR accepted_state = 1 OR redaction = 1)
				   AND (
				     health_last_success_epoch IS NULL
				     OR ? - health_last_success_epoch >= ?
				     OR (health_failure_started_epoch IS NOT NULL
				       AND ? - health_failure_started_epoch >= ?)
				   )`,
			)
			.bind(did, instant.epoch, timeout, instant.epoch, timeout),
		db
			.prepare(
				`UPDATE label_state SET trusted = 0
				 WHERE src = ? AND trusted <> 0
				   AND EXISTS (
				     SELECT 1 FROM labellers source
				     WHERE source.did = ? AND source.active = 1 AND source.trusted = 0
				       AND (source.required_positive = 1 OR source.accepted_state = 1 OR source.redaction = 1)
				   )`,
			)
			.bind(did, did),
	]);
	return (results[1]?.meta.changes ?? 0) > 0;
}

export async function enforceRequiredLabelSourceHealth(
	db: D1Database,
	observedAt: Date,
	timeoutMs = REQUIRED_LABEL_SOURCE_HEALTH_TIMEOUT_MS,
): Promise<string[]> {
	const instant = labelSourceHealthInstant(observedAt);
	const timeout = healthTimeout(timeoutMs);
	const candidates = await db
		.prepare(
			`SELECT did FROM labellers
			 WHERE active = 1 AND trusted = 1
			   AND (required_positive = 1 OR accepted_state = 1 OR redaction = 1)
			   AND (
			     health_last_success_epoch IS NULL
			     OR ? - health_last_success_epoch >= ?
			     OR (health_failure_started_epoch IS NOT NULL
			       AND ? - health_failure_started_epoch >= ?)
			   )
			 ORDER BY did`,
		)
		.bind(instant.epoch, timeout, instant.epoch, timeout)
		.all<{ did: string }>();
	const demoted: string[] = [];
	for (const { did } of candidates.results ?? []) {
		const results = await db.batch([
			db
				.prepare(
					`UPDATE labellers SET
					   trusted = 0,
					   replay_pending = 1,
					   replay_generation = replay_generation + 1
					 WHERE did = ? AND active = 1 AND trusted = 1
					   AND (required_positive = 1 OR accepted_state = 1 OR redaction = 1)
					   AND (
					     health_last_success_epoch IS NULL
					     OR ? - health_last_success_epoch >= ?
					     OR (health_failure_started_epoch IS NOT NULL
					       AND ? - health_failure_started_epoch >= ?)
					   )`,
				)
				.bind(did, instant.epoch, timeout, instant.epoch, timeout),
			db
				.prepare(
					`UPDATE label_state SET trusted = 0
					 WHERE src = ? AND trusted <> 0
					   AND EXISTS (
					     SELECT 1 FROM labellers source
					     WHERE source.did = ? AND source.active = 1 AND source.trusted = 0
					       AND (source.required_positive = 1 OR source.accepted_state = 1 OR source.redaction = 1)
					   )`,
				)
				.bind(did, did),
		]);
		if ((results[0]?.meta.changes ?? 0) > 0) demoted.push(did);
	}
	return demoted;
}

export interface LabelSourceActivationState {
	trusted: boolean;
	replayGeneration: number;
}

export async function readLabelSourceActivationState(
	db: D1Database,
	did: string,
): Promise<LabelSourceActivationState> {
	const row = await db
		.prepare(`SELECT active, trusted, replay_generation FROM labellers WHERE did = ?`)
		.bind(did)
		.first<{ active: number; trusted: number; replay_generation: number }>();
	if (!row || row.active !== 1) throw new Error(`labeler is not configured: ${did}`);
	return { trusted: row.trusted === 1, replayGeneration: row.replay_generation };
}
