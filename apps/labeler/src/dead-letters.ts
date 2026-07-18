/**
 * Dead-letter operational controls (plan W9.6, design §6). The read side of the
 * `dead_letters` table for the console and the effect statement the admin-only
 * retry / quarantine mutations commit. `writeDeadLetter` (discovery-consumer.ts)
 * is the only writer of new rows; those rows land with `status = 'new'` and are
 * resolved here to `retried` or `quarantined`.
 */

import type { DiscoveryJob } from "./env.js";

export type DeadLetterStatus = "new" | "retried" | "quarantined";

export interface StoredDeadLetter {
	id: number;
	did: string;
	collection: string;
	rkey: string;
	reason: string;
	detail: string | null;
	status: string;
	receivedAt: string;
	resolvedAt: string | null;
	resolvedByActionId: string | null;
}

interface DeadLetterRow {
	id: number;
	did: string;
	collection: string;
	rkey: string;
	reason: string;
	detail: string | null;
	status: string;
	received_at: string;
	resolved_at: string | null;
	resolved_by_action_id: string | null;
}

const READ_COLUMNS = `id, did, collection, rkey, reason, detail, status,
	 received_at, resolved_at, resolved_by_action_id`;

/**
 * Dead-letter page, newest first. `id` is a monotonic autoincrement, so keyset
 * pagination on `id DESC` alone is a total order — no timestamp tiebreaker (the
 * `received_at` string has no epoch sibling and can collide). Fetches `limit + 1`
 * so the caller detects a next page without a trailing COUNT.
 */
export async function getDeadLettersPage(
	db: D1Database,
	keysetId: number | null,
	limit: number,
): Promise<StoredDeadLetter[]> {
	const bindings: number[] = [];
	let where = "";
	if (keysetId !== null) {
		where = `WHERE id < ?`;
		bindings.push(keysetId);
	}
	bindings.push(limit + 1);
	const rows = await db
		.prepare(`SELECT ${READ_COLUMNS} FROM dead_letters ${where} ORDER BY id DESC LIMIT ?`)
		.bind(...bindings)
		.all<DeadLetterRow>();
	return (rows.results ?? []).map(rowToStored);
}

/** One dead letter by id, or null when absent. Carries the status the retry /
 * quarantine handlers gate on and the `resolved_by_action_id` they read back
 * post-commit to tell the winner of a concurrent resolve from the loser. */
export async function getDeadLetter(db: D1Database, id: number): Promise<StoredDeadLetter | null> {
	const row = await db
		.prepare(`SELECT ${READ_COLUMNS} FROM dead_letters WHERE id = ?`)
		.bind(id)
		.first<DeadLetterRow>();
	return row ? rowToStored(row) : null;
}

/**
 * Effect statement for a retry / quarantine resolve. The `status = 'new'`
 * predicate makes a second concurrent resolve a zero-row UPDATE (T6): the row
 * flips exactly once and `resolved_by_action_id` records the winner, so a loser
 * that also committed can be detected post-commit and skip its re-enqueue.
 * Batched with the operator_actions row + the operational event by `commitMutation`.
 */
export function buildDeadLetterResolveUpdate(
	db: D1Database,
	input: { id: number; status: Exclude<DeadLetterStatus, "new">; actionId: string; now: Date },
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE dead_letters
			 SET status = ?, resolved_at = ?, resolved_by_action_id = ?
			 WHERE id = ? AND status = 'new'`,
		)
		.bind(input.status, input.now.toISOString(), input.actionId, input.id);
}

/**
 * Reconstructs the discovery job stored in `dead_letters.payload` for a re-drive.
 * `writeDeadLetter` persists the full {@link DiscoveryJob} as JSON, so the retry
 * re-enqueues an identical job — the discovery consumer re-fetches and verifies
 * (uri, cid) from the PDS, and its `runKey` dedup absorbs a duplicate re-drive.
 * Returns null when the payload is missing or not a well-formed job.
 */
export async function readDeadLetterJob(db: D1Database, id: number): Promise<DiscoveryJob | null> {
	const row = await db
		.prepare(`SELECT payload FROM dead_letters WHERE id = ?`)
		.bind(id)
		.first<{ payload: ArrayBuffer | Uint8Array | number[] | null }>();
	if (!row || row.payload === null) return null;
	return decodeDiscoveryJob(row.payload);
}

function decodeDiscoveryJob(payload: ArrayBuffer | Uint8Array | number[]): DiscoveryJob | null {
	const bytes =
		payload instanceof Uint8Array
			? payload
			: payload instanceof ArrayBuffer
				? new Uint8Array(payload)
				: Uint8Array.from(payload);
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
	return isDiscoveryJob(parsed) ? parsed : null;
}

function isDiscoveryJob(value: unknown): value is DiscoveryJob {
	if (!isRecord(value)) return false;
	return (
		typeof value.did === "string" &&
		typeof value.collection === "string" &&
		typeof value.rkey === "string" &&
		typeof value.cid === "string" &&
		(value.operation === "create" || value.operation === "update" || value.operation === "delete")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function rowToStored(row: DeadLetterRow): StoredDeadLetter {
	return {
		id: row.id,
		did: row.did,
		collection: row.collection,
		rkey: row.rkey,
		reason: row.reason,
		detail: row.detail,
		status: row.status,
		receivedAt: row.received_at,
		resolvedAt: row.resolved_at,
		resolvedByActionId: row.resolved_by_action_id,
	};
}
