/**
 * Gated send-orchestration core for publisher notifications (spec §18/§19, plan
 * W10.5 slice 1). This is the security surface of the subsystem: it decides,
 * per triggering action, whether an address may be mailed and what it may
 * receive, then records the delivery attempt in the `notifications` table
 * (migration 0008). The actual email adapter is injected as a
 * {@link NotificationSender}; slice 2 supplies the real Cloudflare Email Sending
 * implementation and wires the triggers.
 *
 * The gate, in order:
 *   1. Fresh contact resolve via {@link resolvePublisherContact} (no caching —
 *      a notice must resolve against the publisher's current metadata). No
 *      resolvable contact is an expected terminal state: an `undeliverable`
 *      audit row, no send.
 *   2. `recipientHash` under the pepper.
 *   3. Suppression / decline short-circuit: a suppressed address or a contact
 *      that said "not me" (`declined`) receives NOTHING — an `undeliverable`
 *      audit row, no send.
 *   4. Confirm-state gate, NEVER `seeded:true`:
 *        * `confirmed`   → substantive NOTICE.
 *        * `unconfirmed` → double opt-in: a content-neutral CONFIRMATION mail,
 *          sent to an address at most ONCE EVER (lifetime cap) and subject to the
 *          per-DID cap. Never a substantive notice.
 *        * `declined`    → nothing (handled in step 3).
 *
 * Atomicity: every send is CLAIMED by inserting the pending `notifications` row
 * guarded by `WHERE NOT EXISTS (suppression)`, so a suppression committed before
 * the claim blocks the send even under a race with the step-3 read. The
 * confirmation claim adds a second guard in the same statement — no prior
 * non-`undeliverable` confirmation row for the hash — which enforces both the
 * lifetime "mail once ever" cap and the concurrency race (of two racing sends
 * exactly one inserts). A suppression landing in the sub-millisecond window
 * between the claim and the external send is the accepted double-opt-in tradeoff:
 * at most one content-neutral confirmation mail, ever.
 *
 * PII: `plaintext_email` lives only on the delivery row and is cleared to NULL on
 * a successful send. Nothing here logs plaintext — logs carry the (public)
 * publisher DID and at most an 8-char recipient-hash prefix, matching slice C's
 * `logOutcome`. The confirm token is never logged.
 */

import { ulid } from "ulidx";

import type { AggregatorClient } from "./aggregator-client.js";
import { CONFIRM_DID_MAX_DISTINCT_RECIPIENTS, CONFIRM_DID_WINDOW_MS } from "./constants.js";
import {
	ensureContact,
	generateConfirmToken,
	getContactState,
	hashConfirmToken,
	isSuppressed,
	recipientHash,
	recordConfirmSent,
} from "./notification-contacts.js";
import type { ContactTarget } from "./publisher-contact.js";
import { resolvePublisherContact } from "./publisher-contact.js";

/** Which audit table the triggering action lives in. No SQL FK (SQLite can't
 * FK-to-one-of-two); the writer here is the only producer of these rows. */
export type NotificationSourceType = "issuance" | "operator";

export interface NotificationSource {
	type: NotificationSourceType;
	id: string;
}

/**
 * The public-safe body of a substantive notice (spec §18/§19). Carries only what
 * a publisher may see: the label effect, a public summary, and the URLs of the
 * public assessment and reconsideration channel. NO private evidence, findings,
 * or exploit detail — the type is the enforcement.
 */
export interface NoticeContent {
	subject: string;
	publicSummary: string;
	assessmentUrl: string;
	effect: string;
	reconsiderationUrl: string;
}

export interface NotificationRequest {
	source: NotificationSource;
	target: ContactTarget;
	notice: NoticeContent;
}

export type SendResult = { ok: true; providerId?: string } | { ok: false; error: string };

export interface ConfirmationPayload {
	to: string;
	confirmUrl: string;
	unsubscribeUrl: string;
	notMeUrl: string;
}

export interface NoticePayload extends NoticeContent {
	to: string;
	unsubscribeUrl: string;
}

/**
 * The injected email adapter. Slice 1 tests supply a fake that records calls;
 * slice 2 supplies the Cloudflare Email Sending implementation. Each method
 * returns a discriminated result — a transport failure is `{ ok: false }`, not a
 * throw, so the caller records `failed` and lets the retry sweep pick it up.
 *
 * SECURITY (slice-2 contract): the `error` string is persisted verbatim in
 * `notifications.last_error` and is NEVER cleared. An implementation MUST NOT put
 * the `confirmUrl` or the raw confirm token into it — that would leak the
 * single-use capability to the database. Return the provider's status/message
 * only, never the payload it was given.
 */
export interface NotificationSender {
	sendConfirmation(payload: ConfirmationPayload): Promise<SendResult>;
	sendNotice(payload: NoticePayload): Promise<SendResult>;
}

export interface SendContext {
	db: D1Database;
	aggregator: AggregatorClient;
	pepper: string;
	sender: NotificationSender;
	/** Public origin of the notification landing endpoints (the
	 * `LABELER_SERVICE_URL` var), e.g. `https://labels.emdashcms.com`. The
	 * confirm/unsubscribe/not-me links are built against it. */
	origin: string;
	now?: () => Date;
}

export type SendOutcome =
	| { status: "notice_sent"; recipientHash: string; providerId?: string }
	| { status: "notice_failed"; recipientHash: string; error: string }
	| { status: "confirmation_sent"; recipientHash: string; providerId?: string }
	| { status: "confirmation_failed"; recipientHash: string; error: string }
	| { status: "rate_limited"; recipientHash: string; scope: "did" }
	| { status: "suppressed"; recipientHash: string }
	| { status: "declined"; recipientHash: string }
	| { status: "already_mailed"; recipientHash: string }
	| { status: "skipped"; recipientHash: string; reason: "contact_state_changed" }
	| { status: "no_contact" };

type NotificationKind = "confirmation" | "notice";

const LAST_ERROR_MAX = 500;

/**
 * Resolve, gate, and send one notification. The entry point slice-2 triggers
 * call. Returns a terminal {@link SendOutcome}; it never throws for an expected
 * non-delivery (no contact, suppressed, declined, rate-limited) — only an
 * aggregator/transport read failure in {@link resolvePublisherContact}
 * propagates, so the caller can retry the whole send.
 */
export async function sendNotification(
	ctx: SendContext,
	request: NotificationRequest,
): Promise<SendOutcome> {
	const now = ctx.now ?? (() => new Date());
	const resolution = await resolvePublisherContact(ctx.aggregator, request.target);
	if ("none" in resolution) {
		await recordUndeliverable(ctx.db, request.source, "notice", null, resolution.none, now());
		logSend(request.target.did, "no_contact", undefined);
		return { status: "no_contact" };
	}

	const hash = await recipientHash(ctx.pepper, resolution.email);
	const nowDate = now();
	const nowIso = nowDate.toISOString();
	const nowMs = nowDate.getTime();

	await ensureContact(ctx.db, hash, nowIso);
	const state = await getContactState(ctx.db, hash);

	if (await isSuppressed(ctx.db, hash)) {
		await recordUndeliverable(ctx.db, request.source, "notice", hash, "suppressed", nowDate);
		logSend(request.target.did, "suppressed", hash);
		return { status: "suppressed", recipientHash: hash };
	}

	if (state === null || state.confirmState === "declined") {
		if (state?.confirmState === "declined") {
			await recordUndeliverable(ctx.db, request.source, "notice", hash, "declined", nowDate);
			logSend(request.target.did, "declined", hash);
			return { status: "declined", recipientHash: hash };
		}
		logSend(request.target.did, "skipped:no_state", hash);
		return { status: "skipped", recipientHash: hash, reason: "contact_state_changed" };
	}

	if (state.confirmState === "confirmed") {
		return sendSubstantiveNotice(ctx, request, hash, resolution.email, nowDate);
	}

	return sendConfirmationMail(ctx, request, hash, resolution.email, {
		date: nowDate,
		ms: nowMs,
	});
}

async function sendSubstantiveNotice(
	ctx: SendContext,
	request: NotificationRequest,
	hash: string,
	email: string,
	now: Date,
): Promise<SendOutcome> {
	const id = newNotificationId();
	const claimed = await claimSend(ctx.db, id, request.source, "notice", hash, email, now);
	if (!claimed) {
		await recordUndeliverable(ctx.db, request.source, "notice", hash, "suppressed", now);
		logSend(request.target.did, "suppressed", hash);
		return { status: "suppressed", recipientHash: hash };
	}

	const result = await ctx.sender.sendNotice({
		...request.notice,
		to: email,
		unsubscribeUrl: buildActionUrl(ctx.origin, "unsubscribe", hash),
	});
	await finalizeSend(ctx.db, id, result, now);
	if (result.ok) {
		logSend(request.target.did, "notice_sent", hash);
		return { status: "notice_sent", recipientHash: hash, providerId: result.providerId };
	}
	logSend(request.target.did, "notice_failed", hash);
	return { status: "notice_failed", recipientHash: hash, error: result.error };
}

async function sendConfirmationMail(
	ctx: SendContext,
	request: NotificationRequest,
	hash: string,
	email: string,
	now: { date: Date; ms: number },
): Promise<SendOutcome> {
	// Per-DID best-effort gate. The count→claim→ledger sequence is a non-atomic
	// check-then-act: concurrent confirmations to DISTINCT victims for one DID can
	// overshoot the cap (each victim still receives at most one mail — the lifetime
	// cap guarantees that — so it admits a few extra distinct victims, it never
	// bombs anyone). Exact enforcement needs a serialized claim (a Durable Object)
	// and is deferred to slice 2. The gate returns before any write, so a sustained
	// DID email-bomb costs no rows; the ledger is written only after a successful
	// claim (an actual first-ever mail), so a repeat trigger for an already-mailed
	// address writes nothing and cannot bloat the ledger or falsely trip the cap.
	const sinceMs = now.ms - CONFIRM_DID_WINDOW_MS;
	const distinctRecipients = await countDistinctConfirmRecipients(
		ctx.db,
		request.target.did,
		sinceMs,
	);
	if (distinctRecipients >= CONFIRM_DID_MAX_DISTINCT_RECIPIENTS) {
		logSend(request.target.did, "rate_limited:did", hash);
		return { status: "rate_limited", recipientHash: hash, scope: "did" };
	}

	// Atomic claim: suppression + lifetime "mail once ever" cap + concurrency, all
	// in one INSERT...SELECT (see claimSend). A false means one of those fired.
	const id = newNotificationId();
	const claimed = await claimSend(
		ctx.db,
		id,
		request.source,
		"confirmation",
		hash,
		email,
		now.date,
	);
	if (!claimed) {
		// Suppression is pre-checked upstream, so a false here is almost always the
		// lifetime cap. The cheap re-check only distinguishes a suppression that
		// landed in the pre-check→claim window — an audit nicety, not correctness.
		if (await isSuppressed(ctx.db, hash)) {
			logSend(request.target.did, "suppressed", hash);
			return { status: "suppressed", recipientHash: hash };
		}
		logSend(request.target.did, "already_mailed", hash);
		return { status: "already_mailed", recipientHash: hash };
	}

	await recordConfirmLedgerEntry(ctx.db, request.target.did, hash, now.ms);

	const token = generateConfirmToken();
	const tokenHash = await hashConfirmToken(token);
	const recorded = await recordConfirmSent(ctx.db, hash, tokenHash, now.ms);
	if (!recorded) {
		// The claim already enforced the lifetime cap and concurrency; a false here
		// is only the contact leaving `unconfirmed` between the state read and this
		// stamp. Retire the claimed row rather than mail a dead-token confirmation.
		await markRowUndeliverable(ctx.db, id, "contact_state_changed", now.date);
		logSend(request.target.did, "skipped:contact_state_changed", hash);
		return { status: "skipped", recipientHash: hash, reason: "contact_state_changed" };
	}

	const result = await ctx.sender.sendConfirmation({
		to: email,
		confirmUrl: buildActionUrl(ctx.origin, "confirm", hash, token),
		unsubscribeUrl: buildActionUrl(ctx.origin, "unsubscribe", hash),
		notMeUrl: buildActionUrl(ctx.origin, "not-me", hash),
	});
	await finalizeSend(ctx.db, id, result, now.date);
	if (result.ok) {
		logSend(request.target.did, "confirmation_sent", hash);
		return { status: "confirmation_sent", recipientHash: hash, providerId: result.providerId };
	}
	logSend(request.target.did, "confirmation_failed", hash);
	return { status: "confirmation_failed", recipientHash: hash, error: result.error };
}

/**
 * Claim a send by inserting the pending delivery row, guarded atomically. The
 * suppression guard (`WHERE NOT EXISTS (suppression)`) is on both kinds: a
 * suppression committed before the claim blocks it. A `confirmation` claim adds a
 * second guard enforcing the LIFETIME cap and the concurrency race in the same
 * INSERT...SELECT — it inserts only if NO prior non-`undeliverable` confirmation
 * row exists for this recipient hash, so an address is mailed a confirmation at
 * most once ever, and of two racing sends exactly one inserts (the second's
 * subquery sees the first's `pending` row). An `undeliverable` prior (a race
 * loser or a suppressed-at-claim that never mailed) is excluded, so it can never
 * block a later legitimate confirmation. Returns whether the row was inserted.
 */
async function claimSend(
	db: D1Database,
	id: string,
	source: NotificationSource,
	kind: NotificationKind,
	hash: string,
	email: string,
	now: Date,
): Promise<boolean> {
	const columns = `(id, source_type, source_id, kind, channel, recipient_hash, state, attempts,
			 plaintext_email, created_at, created_at_epoch_ms)`;
	const row = `SELECT ?, ?, ?, ?, 'email', ?, 'pending', 0, ?, ?, ?`;
	const notSuppressed = `WHERE NOT EXISTS (SELECT 1 FROM notification_suppressions WHERE recipient_hash = ?)`;
	const binds: (string | number)[] = [
		id,
		source.type,
		source.id,
		kind,
		hash,
		email,
		now.toISOString(),
		now.getTime(),
		hash,
	];

	if (kind === "confirmation") {
		const result = await db
			.prepare(
				`INSERT INTO notifications ${columns} ${row} ${notSuppressed}
				 AND NOT EXISTS (
					SELECT 1 FROM notifications
					WHERE recipient_hash = ? AND kind = 'confirmation' AND state != 'undeliverable'
				 )`,
			)
			.bind(...binds, hash)
			.run();
		return result.meta.changes > 0;
	}

	const result = await db
		.prepare(`INSERT INTO notifications ${columns} ${row} ${notSuppressed}`)
		.bind(...binds)
		.run();
	return result.meta.changes > 0;
}

/** Flip a claimed row to its terminal state. On success: `sent`, `provider_id`
 * and `sent_at` set, `plaintext_email` CLEARED. On failure: `failed`,
 * `last_error` recorded, `attempts` bumped, plaintext retained for the retry.
 * The `AND state = 'pending'` guard makes this a one-shot transition — it can
 * never overwrite an already-terminal row (belt-and-braces against a
 * double-finalize). */
async function finalizeSend(
	db: D1Database,
	id: string,
	result: SendResult,
	now: Date,
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
		return;
	}
	await db
		.prepare(
			`UPDATE notifications
			 SET state = 'failed', last_error = ?, attempts = attempts + 1
			 WHERE id = ? AND state = 'pending'`,
		)
		.bind(truncateError(result.error), id)
		.run();
}

/** Insert a terminal `undeliverable` audit row for a send that was never
 * attempted (no contact, suppressed, declined). Holds no plaintext — nothing
 * will be sent. `recipient_hash` is NULL only for the no-contact case. */
async function recordUndeliverable(
	db: D1Database,
	source: NotificationSource,
	kind: NotificationKind,
	hash: string | null,
	reason: string,
	now: Date,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO notifications
				(id, source_type, source_id, kind, channel, recipient_hash, state, attempts,
				 last_error, created_at, created_at_epoch_ms)
			 VALUES (?, ?, ?, ?, 'email', ?, 'undeliverable', 0, ?, ?, ?)`,
		)
		.bind(
			newNotificationId(),
			source.type,
			source.id,
			kind,
			hash,
			reason,
			now.toISOString(),
			now.getTime(),
		)
		.run();
}

/** Flip an already-claimed pending row to `undeliverable`, clearing plaintext.
 * Used when the contact left `unconfirmed` in the race after the claim. */
async function markRowUndeliverable(
	db: D1Database,
	id: string,
	reason: string,
	now: Date,
): Promise<void> {
	await db
		.prepare(
			`UPDATE notifications
			 SET state = 'undeliverable', last_error = ?, plaintext_email = NULL, sent_at = ?
			 WHERE id = ? AND state = 'pending'`,
		)
		.bind(reason, now.toISOString(), id)
		.run();
}

/** Distinct recipients this DID has sent confirmation mail to since `sinceMs` —
 * the per-DID rate-limit read (counts victims, not repeats). */
async function countDistinctConfirmRecipients(
	db: D1Database,
	did: string,
	sinceMs: number,
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(DISTINCT recipient_hash) AS n FROM notification_confirm_ledger
			 WHERE publisher_did = ? AND sent_at_epoch_ms >= ?`,
		)
		.bind(did, sinceMs)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

async function recordConfirmLedgerEntry(
	db: D1Database,
	did: string,
	hash: string,
	epochMs: number,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO notification_confirm_ledger (id, publisher_did, recipient_hash, sent_at_epoch_ms)
			 VALUES (?, ?, ?, ?)`,
		)
		.bind(`ncl_${ulid()}`, did, hash, epochMs)
		.run();
}

function buildActionUrl(
	origin: string,
	action: "confirm" | "unsubscribe" | "not-me",
	hash: string,
	token?: string,
): string {
	const url = new URL(`/notifications/${action}`, origin);
	url.searchParams.set("c", hash);
	if (token !== undefined) url.searchParams.set("t", token);
	return url.toString();
}

function newNotificationId(): string {
	return `ntf_${ulid()}`;
}

function truncateError(error: string): string {
	return error.length > LAST_ERROR_MAX ? error.slice(0, LAST_ERROR_MAX) : error;
}

function logSend(did: string, outcome: string, hash: string | undefined): void {
	console.log("[notifications]", {
		action: "send",
		outcome,
		did,
		hashPrefix: hash?.slice(0, 8),
	});
}
