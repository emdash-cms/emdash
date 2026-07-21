/**
 * Global automation kill-switch (spec §11.3). A single `automation_state` row
 * (`id = 1`, seeded by migration 0005) gates the discovery consumer's ingestion
 * path; manual/admin issuance is never gated by it, so an emergency `!takedown`
 * stays issuable during an incident.
 */

/**
 * Raised when the pause flag cannot be read (missing singleton row or a D1
 * error). The discovery consumer maps this to retry — automation must never
 * issue past an unreadable switch, so the read fails closed.
 */
export class AutomationStateUnavailableError extends Error {
	override readonly name = "AutomationStateUnavailableError";
}

/**
 * Raised when an in-flight assessment run re-reads the kill-switch on Workflow
 * entry and finds automation paused. Halts the run before it spends AI/network
 * work; the Workflow step retries, resuming once automation is unpaused.
 */
export class AutomationPausedError extends Error {
	override readonly name = "AutomationPausedError";
}

export interface AutomationPauseUpdate {
	paused: boolean;
	reason: string | null;
	actionId: string;
	now: Date;
}

/**
 * Reads the kill-switch. Fails closed: a missing singleton row or a read error
 * throws rather than reporting "not paused", so the ingestion path can only
 * proceed on a positive, successful read of `paused = 0`.
 */
export async function isAutomationPaused(db: D1Database): Promise<boolean> {
	let row: { paused: number } | null;
	try {
		row = await db
			.prepare(`SELECT paused FROM automation_state WHERE id = 1`)
			.first<{ paused: number }>();
	} catch (error) {
		throw new AutomationStateUnavailableError("automation_state is unreadable", { cause: error });
	}
	if (!row) throw new AutomationStateUnavailableError("automation_state singleton row is missing");
	return row.paused === 1;
}

/**
 * Effect statement for a pause or resume. Idempotent — pausing an already-paused
 * switch is a harmless re-write. Batched with the operator_actions row (and, for
 * a pause, an `automation-paused` operational event) by `commitMutation`.
 */
export function buildAutomationPauseUpdate(
	db: D1Database,
	input: AutomationPauseUpdate,
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE automation_state
			 SET paused = ?, paused_reason = ?, paused_by_action_id = ?,
			     updated_at = ?, updated_at_epoch_ms = ?
			 WHERE id = 1`,
		)
		.bind(
			input.paused ? 1 : 0,
			input.reason,
			input.actionId,
			input.now.toISOString(),
			input.now.getTime(),
		);
}
