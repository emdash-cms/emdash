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
	confirmContactVerified,
	ensureContact,
	generateConfirmToken,
	getContactState,
	hashConfirmToken,
	isSuppressed,
	recipientHash,
	recordConfirmSent,
	suppress,
	type SuppressionReason,
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

/**
 * A send attempt's result. A transport failure is `{ ok: false }`, not a throw,
 * so the caller records `failed` and lets the retry sweep pick it up.
 *
 * `suppress` is the terminal-bounce discriminant: a provider hard-bounce /
 * complaint suppression (Cloudflare's `E_RECIPIENT_SUPPRESSED`) that the
 * orchestration layer maps to our own {@link SuppressionReason} — the row is
 * retired `undeliverable` (never retried) and the address is added to the
 * suppression ledger, so our do-not-contact set learns what the provider knows.
 *
 * SECURITY (slice-2 contract): `error` is persisted verbatim in
 * `notifications.last_error` and NEVER cleared. An implementation MUST NOT put
 * the `confirmUrl`, raw confirm token, or email body into it — that would leak a
 * single-use capability / PII to the database. Return the provider's status code
 * only, never the payload it was given.
 */
export type SendResult =
	| { ok: true; providerId?: string }
	| { ok: false; error: string; suppress?: SuppressionReason };

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
	/**
	 * When true, an `unconfirmed` contact for a VERIFIED publisher is upgraded to
	 * `confirmed` in place (a token-less confirm) and receives the substantive
	 * notice directly, skipping double opt-in (plan W10.5 slice 2). The caller
	 * computes this from the publisher's in-force verification claims and MUST fail
	 * closed — an unreadable verification state leaves it unset, so the address
	 * falls back to the confirmation-mail path. Suppressed / declined contacts are
	 * short-circuited before this flag is consulted, so verification never revives
	 * a do-not-contact address.
	 */
	verifiedPublisher?: boolean;
	now?: () => Date;
}

export type SendOutcome =
	| { status: "notice_sent"; recipientHash: string; providerId?: string }
	| { status: "notice_failed"; recipientHash: string; error: string }
	| { status: "confirmation_sent"; recipientHash: string; providerId?: string }
	| { status: "confirmation_failed"; recipientHash: string; error: string }
	| { status: "provider_suppressed"; recipientHash: string }
	| { status: "rate_limited"; recipientHash: string; scope: "did" }
	| { status: "suppressed"; recipientHash: string }
	| { status: "declined"; recipientHash: string }
	| { status: "already_mailed"; recipientHash: string }
	| { status: "already_notified"; recipientHash: string }
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

	// Suppression is checked BEFORE ensureContact (matching seedPublisherContact),
	// so a suppressed address is never seeded with an unconfirmed contact row.
	if (await isSuppressed(ctx.db, hash)) {
		await recordUndeliverable(ctx.db, request.source, "notice", hash, "suppressed", nowDate);
		logSend(request.target.did, "suppressed", hash);
		return { status: "suppressed", recipientHash: hash };
	}

	await ensureContact(ctx.db, hash, nowIso);
	const state = await getContactState(ctx.db, hash);

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

	// Verified-publisher skip: an in-force verification claim upgrades the
	// unconfirmed contact to confirmed in place and delivers the substantive
	// notice directly. The upgrade is guarded on `unconfirmed`, so a decline that
	// raced the state read leaves it false and we fall back to double opt-in.
	if (ctx.verifiedPublisher === true) {
		const upgraded = await confirmContactVerified(ctx.db, hash, nowIso);
		if (upgraded) {
			logSend(request.target.did, "verified_skip", hash);
			return sendSubstantiveNotice(ctx, request, hash, resolution.email, nowDate);
		}
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
		// The notice claim guards on suppression AND per-source dedup (see
		// claimSend). A suppression that landed before the claim is recorded as an
		// undeliverable audit row; otherwise a non-undeliverable notice row already
		// exists for this source — a concurrent duplicate of the same action — so
		// nothing is written and no second mail goes out (the hard "one notice per
		// action" invariant, closed atomically rather than by the trigger's
		// check-then-act dedup).
		if (await isSuppressed(ctx.db, hash)) {
			await recordUndeliverable(ctx.db, request.source, "notice", hash, "suppressed", now);
			logSend(request.target.did, "suppressed", hash);
			return { status: "suppressed", recipientHash: hash };
		}
		logSend(request.target.did, "already_notified", hash);
		return { status: "already_notified", recipientHash: hash };
	}

	const result = await ctx.sender.sendNotice({
		...request.notice,
		to: email,
		unsubscribeUrl: buildActionUrl(ctx.origin, "unsubscribe", hash),
	});
	if (!result.ok && result.suppress !== undefined) {
		await markProviderSuppressed(ctx.db, id, hash, result.suppress, now);
		logSend(request.target.did, "provider_suppressed", hash);
		return { status: "provider_suppressed", recipientHash: hash };
	}
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
	// DID email-bomb costs no rows; the ledger is written only once the token is
	// stamped and the mail is about to go out, so neither an already-mailed repeat
	// (blocked at the claim) nor a contact_state_changed abort (blocked at the
	// stamp) leaves a ledger row eating a distinct-recipient slot.
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

	const token = generateConfirmToken();
	const tokenHash = await hashConfirmToken(token);
	const recorded = await recordConfirmSent(ctx.db, hash, tokenHash, now.ms);
	if (!recorded) {
		// The claim already enforced the lifetime cap and concurrency; a false here
		// is only the contact leaving `unconfirmed` between the state read and this
		// stamp. Retire the claimed row rather than mail a dead-token confirmation.
		// No ledger row was written, so the aborted mail consumes no per-DID budget.
		await markRowUndeliverable(ctx.db, id, "contact_state_changed");
		logSend(request.target.did, "skipped:contact_state_changed", hash);
		return { status: "skipped", recipientHash: hash, reason: "contact_state_changed" };
	}

	// Ledger only now — after a stamped token, before the send. A failed SEND still
	// consumes budget (the conservative fail-safe), but an abort above does not.
	await recordConfirmLedgerEntry(ctx.db, request.target.did, hash, now.ms);

	const result = await ctx.sender.sendConfirmation({
		to: email,
		confirmUrl: buildActionUrl(ctx.origin, "confirm", hash, token),
		unsubscribeUrl: buildActionUrl(ctx.origin, "unsubscribe", hash),
		notMeUrl: buildActionUrl(ctx.origin, "not-me", hash),
	});
	if (!result.ok && result.suppress !== undefined) {
		// A provider hard-bounce on the confirmation mail retires the row
		// `undeliverable` (which reopens the lifetime cap) and records the
		// suppression, so the address is never re-mailed.
		await markProviderSuppressed(ctx.db, id, hash, result.suppress, now.date);
		logSend(request.target.did, "provider_suppressed", hash);
		return { status: "provider_suppressed", recipientHash: hash };
	}
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

	// A `notice` claim adds a per-source dedup guard in the same INSERT...SELECT:
	// it inserts only if NO non-`undeliverable` notice row already exists for this
	// (source_type, source_id). One triggering action therefore mails at most one
	// substantive notice even under concurrent duplicate triggers (an original and
	// a racing replay), of which exactly one claims. An `undeliverable` prior (a
	// suppressed-at-claim that never mailed) is excluded so it can't foreclose a
	// later legitimate notice for the same source.
	const result = await db
		.prepare(
			`INSERT INTO notifications ${columns} ${row} ${notSuppressed}
			 AND NOT EXISTS (
				SELECT 1 FROM notifications
				WHERE source_type = ? AND source_id = ? AND kind = 'notice' AND state != 'undeliverable'
			 )`,
		)
		.bind(...binds, source.type, source.id)
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
 * Used when the contact left `unconfirmed` in the race after the claim. Leaves
 * `sent_at` NULL — the mail was never handed to a provider. */
async function markRowUndeliverable(db: D1Database, id: string, reason: string): Promise<void> {
	await db
		.prepare(
			`UPDATE notifications
			 SET state = 'undeliverable', last_error = ?, plaintext_email = NULL
			 WHERE id = ? AND state = 'pending'`,
		)
		.bind(reason, id)
		.run();
}

/**
 * Retire a claimed pending row after the provider reported the recipient is
 * hard-suppressed (Cloudflare `E_RECIPIENT_SUPPRESSED`): the row goes
 * `undeliverable` with plaintext cleared and is never retried, and the address is
 * added to our suppression ledger so every future send short-circuits. For a
 * confirmation row the undeliverable transition reopens the lifetime cap, but the
 * fresh suppression row bars any re-mail — the address is off the list for good.
 * `last_error` carries only the reason code, never the email payload.
 */
async function markProviderSuppressed(
	db: D1Database,
	id: string,
	hash: string,
	reason: SuppressionReason,
	now: Date,
): Promise<void> {
	// Suppress FIRST, THEN retire the row (which reopens a confirmation's lifetime
	// cap). Before the suppression write the row is still a non-`undeliverable`
	// confirmation prior, so a concurrent live claim is blocked by the lifetime
	// guard; after it, by the suppression guard — closing the window where both
	// cap-open and suppression-absent would admit a second mail.
	await suppress(db, hash, reason, now.toISOString(), now.getTime());
	await db
		.prepare(
			`UPDATE notifications
			 SET state = 'undeliverable', plaintext_email = NULL, last_error = ?, attempts = attempts + 1
			 WHERE id = ? AND state = 'pending'`,
		)
		.bind(`provider_suppressed:${reason}`, id)
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

export function buildActionUrl(
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
