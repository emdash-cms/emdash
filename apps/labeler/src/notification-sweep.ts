/**
 * Publisher-notification retry sweep (spec §18, plan W10.5 slice 2). A cron
 * branch that keeps the delivery table live: it re-drives failed and
 * crash-stuck sends, abandons the exhausted ones, and prunes terminal rows.
 *
 * The 5-minute cron is the backoff interval — each pass re-drives every `failed`
 * row and every `pending` row older than {@link NOTIFICATION_STUCK_PENDING_MS}
 * (crashed in-flight, contract c) exactly once, bumping `attempts` at the claim.
 * A row that has reached {@link NOTIFICATION_MAX_SEND_ATTEMPTS} is abandoned to
 * `undeliverable` with plaintext cleared. For a CONFIRMATION row abandonment
 * REOPENS the lifetime cap (the claim excludes `undeliverable` priors), so a
 * crashed or exhausted confirmation never silently forecloses the channel — the
 * slice-1 contract (c) this sweep exists to honor.
 *
 * Re-render, not re-store (plaintext minimization): a confirmation retry mints a
 * FRESH token (only the hash was ever stored — contract b) and rebuilds its
 * links; a notice retry re-derives its public content from the source row
 * (`resolveNoticeForSource`). The recipient address is read from the row's
 * `plaintext_email`, the only place it lives.
 *
 * Every step is best-effort and self-contained: an error on one row is logged
 * and the sweep continues, and a sweep failure never disturbs the other cron
 * branches (the caller wraps it in its own `waitUntil`+catch).
 */

import {
	CONFIRM_DID_WINDOW_MS,
	NOTIFICATION_MAX_SEND_ATTEMPTS,
	NOTIFICATION_RETENTION_MS,
	NOTIFICATION_STUCK_PENDING_MS,
	NOTIFICATION_SWEEP_BATCH,
} from "./constants.js";
import {
	generateConfirmToken,
	hashConfirmToken,
	recordConfirmSent,
	suppress,
	type SuppressionReason,
} from "./notification-contacts.js";
import { buildActionUrl, type SendResult } from "./notification-send.js";
import { resolveNoticeForSource, type NotifyDeps } from "./notification-triggers.js";

interface SweepRow {
	id: string;
	kind: "confirmation" | "notice";
	source_type: string;
	source_id: string;
	recipient_hash: string | null;
	plaintext_email: string | null;
	attempts: number;
	state: string;
}

export interface SweepStats {
	scanned: number;
	sent: number;
	failed: number;
	abandoned: number;
	suppressed: number;
	skipped: number;
	cleaned: number;
	prunedLedger: number;
}

/**
 * One sweep pass. Re-drives retryable rows, abandons exhausted ones, then prunes
 * terminal rows and stale confirm-ledger entries.
 */
export async function runNotificationSweep(deps: NotifyDeps): Promise<SweepStats> {
	const now = deps.now ?? (() => new Date());
	const nowMs = now().getTime();
	const stats: SweepStats = {
		scanned: 0,
		sent: 0,
		failed: 0,
		abandoned: 0,
		suppressed: 0,
		skipped: 0,
		cleaned: 0,
		prunedLedger: 0,
	};

	const stuckBefore = nowMs - NOTIFICATION_STUCK_PENDING_MS;
	const candidates = await deps.db
		.prepare(
			`SELECT id, kind, source_type, source_id, recipient_hash, plaintext_email, attempts, state
			 FROM notifications
			 WHERE state = 'failed' OR (state = 'pending' AND created_at_epoch_ms < ?)
			 ORDER BY created_at_epoch_ms
			 LIMIT ?`,
		)
		.bind(stuckBefore, NOTIFICATION_SWEEP_BATCH)
		.all<SweepRow>();

	for (const row of candidates.results ?? []) {
		stats.scanned++;
		try {
			await sweepRow(deps, row, now(), stats);
		} catch (error) {
			console.error("[notifications] sweep row failed", {
				id: row.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	stats.cleaned = await cleanupTerminalRows(deps.db, nowMs - NOTIFICATION_RETENTION_MS);
	stats.prunedLedger = await pruneConfirmLedger(deps.db, nowMs - CONFIRM_DID_WINDOW_MS);

	console.log("[notifications]", { action: "sweep", ...stats });
	return stats;
}

async function sweepRow(
	deps: NotifyDeps,
	row: SweepRow,
	now: Date,
	stats: SweepStats,
): Promise<void> {
	// Exhausted: abandon before any further send. For a confirmation this reopens
	// the lifetime cap; plaintext is cleared either way.
	if (row.attempts >= NOTIFICATION_MAX_SEND_ATTEMPTS) {
		if (await abandonRow(deps.db, row.id, "max_attempts")) stats.abandoned++;
		return;
	}

	// A row with no address/hash can never send — treat as terminal. (Undeliverable
	// audit rows never enter the candidate set; this guards a corrupt row.)
	if (row.plaintext_email === null || row.recipient_hash === null) {
		if (await abandonRow(deps.db, row.id, "no_plaintext")) stats.abandoned++;
		return;
	}

	// Exclusive claim: bump attempts under a CAS on the observed count, so two
	// concurrent sweeps never re-drive the same row twice. The winner flips the
	// row to `pending`; a stuck-pending row stays pending but its attempts advance.
	const claimed = await claimRetry(deps.db, row.id, row.attempts);
	if (!claimed) {
		stats.skipped++;
		return;
	}

	const to = row.plaintext_email;
	const hash = row.recipient_hash;

	let result: SendResult;
	if (row.kind === "confirmation") {
		// Fresh token every retry — only the hash was ever stored (contract b), and
		// a reused token would be unrecoverable. Stamped on the still-unconfirmed
		// contact; if it has since confirmed/declined, the confirmation is moot.
		const token = generateConfirmToken();
		const tokenHash = await hashConfirmToken(token);
		const recorded = await recordConfirmSent(deps.db, hash, tokenHash, now.getTime());
		if (!recorded) {
			if (await finishAbandon(deps.db, row.id, "contact_state_changed")) stats.abandoned++;
			return;
		}
		result = await deps.sender.sendConfirmation({
			to,
			confirmUrl: buildActionUrl(deps.serviceUrl, "confirm", hash, token),
			unsubscribeUrl: buildActionUrl(deps.serviceUrl, "unsubscribe", hash),
			notMeUrl: buildActionUrl(deps.serviceUrl, "not-me", hash),
		});
	} else {
		const notice = await resolveNoticeForSource(deps, row.source_type, row.source_id);
		if (!notice) {
			if (await finishAbandon(deps.db, row.id, "source_unavailable")) stats.abandoned++;
			return;
		}
		result = await deps.sender.sendNotice({
			...notice,
			to,
			unsubscribeUrl: buildActionUrl(deps.serviceUrl, "unsubscribe", hash),
		});
	}

	await finalizeRetry(deps.db, row.id, hash, result, now, stats);
}

/** Finalize a re-driven row. Attempts were already bumped at the claim, so a
 * failure does NOT bump again. Success clears plaintext; provider suppression
 * retires the row and records our own suppression (never retried). */
async function finalizeRetry(
	db: D1Database,
	id: string,
	hash: string,
	result: SendResult,
	now: Date,
	stats: SweepStats,
): Promise<void> {
	if (result.ok) {
		await db
			.prepare(
				`UPDATE notifications
				 SET state = 'sent', provider_id = ?, sent_at = ?, plaintext_email = NULL, last_error = NULL
				 WHERE id = ? AND state = 'pending'`,
			)
			.bind(result.providerId ?? null, now.toISOString(), id)
			.run();
		stats.sent++;
		return;
	}
	if (result.suppress !== undefined) {
		await markSuppressed(db, id, hash, result.suppress, now);
		stats.suppressed++;
		return;
	}
	await db
		.prepare(
			`UPDATE notifications SET state = 'failed', last_error = ? WHERE id = ? AND state = 'pending'`,
		)
		.bind(truncate(result.error), id)
		.run();
	stats.failed++;
}

/** CAS claim: only the sweep that observed `attempts` wins, flipping the row to
 * `pending` and advancing the counter. */
async function claimRetry(db: D1Database, id: string, attempts: number): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE notifications SET state = 'pending', attempts = attempts + 1
			 WHERE id = ? AND attempts = ? AND state IN ('failed', 'pending')`,
		)
		.bind(id, attempts)
		.run();
	return result.meta.changes > 0;
}

/** Retire a not-yet-claimed row (exhausted / corrupt) to `undeliverable`, guarded
 * on it still being retryable so a concurrent claim wins cleanly. */
async function abandonRow(db: D1Database, id: string, reason: string): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE notifications
			 SET state = 'undeliverable', plaintext_email = NULL, last_error = ?
			 WHERE id = ? AND state IN ('failed', 'pending')`,
		)
		.bind(reason, id)
		.run();
	return result.meta.changes > 0;
}

/** Retire an already-claimed (`pending`) row to `undeliverable`. */
async function finishAbandon(db: D1Database, id: string, reason: string): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE notifications
			 SET state = 'undeliverable', plaintext_email = NULL, last_error = ?
			 WHERE id = ? AND state = 'pending'`,
		)
		.bind(reason, id)
		.run();
	return result.meta.changes > 0;
}

async function markSuppressed(
	db: D1Database,
	id: string,
	hash: string,
	reason: SuppressionReason,
	now: Date,
): Promise<void> {
	await db
		.prepare(
			`UPDATE notifications
			 SET state = 'undeliverable', plaintext_email = NULL, last_error = ?
			 WHERE id = ? AND state = 'pending'`,
		)
		.bind(`provider_suppressed:${reason}`, id)
		.run();
	await suppress(db, hash, reason, now.toISOString(), now.getTime());
}

/**
 * Delete terminal rows older than retention: every `undeliverable` row and every
 * SENT NOTICE. A `sent` CONFIRMATION row is KEPT — it holds the lifetime cap and
 * carries no plaintext (cleared on send), so retaining it costs nothing and
 * prevents an address being re-mailed a confirmation after 30 days.
 */
async function cleanupTerminalRows(db: D1Database, cutoffMs: number): Promise<number> {
	const result = await db
		.prepare(
			`DELETE FROM notifications
			 WHERE created_at_epoch_ms < ?
			   AND (state = 'undeliverable' OR (state = 'sent' AND kind = 'notice'))`,
		)
		.bind(cutoffMs)
		.run();
	return result.meta.changes ?? 0;
}

/** Prune confirm-ledger rows below the per-DID rolling window — they can no
 * longer affect the distinct-recipient count. */
async function pruneConfirmLedger(db: D1Database, cutoffMs: number): Promise<number> {
	const result = await db
		.prepare(`DELETE FROM notification_confirm_ledger WHERE sent_at_epoch_ms < ?`)
		.bind(cutoffMs)
		.run();
	return result.meta.changes ?? 0;
}

const LAST_ERROR_MAX = 500;
function truncate(error: string): string {
	return error.length > LAST_ERROR_MAX ? error.slice(0, LAST_ERROR_MAX) : error;
}
