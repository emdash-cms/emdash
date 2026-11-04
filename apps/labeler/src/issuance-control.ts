export class IssuancePausedError extends Error {
	override readonly name = "IssuancePausedError";
}

export async function isIssuancePaused(db: D1Database): Promise<boolean> {
	const value = await db
		.prepare("SELECT value FROM service_state WHERE key = 'issuance_paused'")
		.first<string>("value");
	return value === "1";
}

export async function setIssuancePaused(input: {
	db: D1Database;
	paused: boolean;
	actorDid: string;
	role: "admin";
	reason: string;
	idempotencyKey: string;
	now: Date;
}): Promise<{ paused: boolean }> {
	const action = input.paused ? "pause-issuance" : "resume-issuance";
	await input.db.batch([
		input.db
			.prepare(
				`INSERT INTO operator_actions
				   (actor_did, actor_role, action, subject_uri, subject_cid, reason,
				    idempotency_key, created_at)
				 VALUES (?, 'admin', ?, NULL, NULL, ?, ?, ?)
				 ON CONFLICT(idempotency_key) DO NOTHING`,
			)
			.bind(input.actorDid, action, input.reason, input.idempotencyKey, input.now.toISOString()),
		input.db
			.prepare(
				`INSERT INTO service_state (key, value, updated_at)
				 SELECT 'issuance_paused',
				        CASE action.action WHEN 'pause-issuance' THEN '1' ELSE '0' END,
				        action.created_at
				 FROM operator_actions action
				 WHERE action.idempotency_key = ?
				   AND action.actor_did = ?
				   AND action.actor_role = 'admin'
				   AND action.action = ?
				   AND action.reason = ?
				   AND action.id > COALESCE(
				     CAST((SELECT marker.value FROM service_state marker
				           WHERE marker.key = 'issuance_control_action_id') AS INTEGER),
				     0
				   )
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			)
			.bind(input.idempotencyKey, input.actorDid, action, input.reason),
		input.db
			.prepare(
				`INSERT INTO service_state (key, value, updated_at)
				 SELECT 'issuance_control_action_id', CAST(action.id AS TEXT), action.created_at
				 FROM operator_actions action
				 WHERE action.idempotency_key = ?
				   AND action.actor_did = ?
				   AND action.actor_role = 'admin'
				   AND action.action = ?
				   AND action.reason = ?
				   AND action.id > COALESCE(
				     CAST((SELECT marker.value FROM service_state marker
				           WHERE marker.key = 'issuance_control_action_id') AS INTEGER),
				     0
				   )
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			)
			.bind(input.idempotencyKey, input.actorDid, action, input.reason),
	]);
	const stored = await input.db
		.prepare(
			`SELECT actor_did, actor_role, action, reason
			 FROM operator_actions WHERE idempotency_key = ?`,
		)
		.bind(input.idempotencyKey)
		.first<{ actor_did: string; actor_role: string; action: string; reason: string }>();
	if (
		!stored ||
		stored.actor_did !== input.actorDid ||
		stored.actor_role !== input.role ||
		stored.action !== action ||
		stored.reason !== input.reason
	) {
		throw new TypeError("operator idempotency key is already bound to another action");
	}
	return { paused: await isIssuancePaused(input.db) };
}
