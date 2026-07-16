/**
 * Contact-state foundation for the publisher-notification subsystem (spec
 * §18/§19, plan W10.4). Addresses are keyed exclusively by an HMAC-SHA256
 * `recipient_hash`; plaintext email never enters these tables or this module's
 * persisted output. The delivery row that briefly holds plaintext lives in a
 * later slice (W10.5) and is out of scope here.
 *
 * Backs two tables from migration 0007: `notification_contacts` (the
 * double-opt-in state machine) and `notification_suppressions` (the universal
 * do-not-contact set). Distinct from the operator `notification_outbox`.
 */

const encoder = new TextEncoder();

export type ConfirmState = "unconfirmed" | "confirmed" | "declined";

export type SuppressionReason = "bounce" | "complaint" | "unsubscribe" | "not_me";

export interface ContactState {
	recipientHash: string;
	confirmState: ConfirmState;
	confirmTokenHash: string | null;
	firstSeenAt: string;
	confirmedAt: string | null;
	lastConfirmSentAtEpochMs: number | null;
}

interface ContactRow {
	recipient_hash: string;
	confirm_state: ConfirmState;
	confirm_token_hash: string | null;
	first_seen_at: string;
	confirmed_at: string | null;
	last_confirm_sent_at_epoch_ms: number | null;
}

/**
 * The peppered address key. Mirrors {@link import("./signing-runtime.js")}'s
 * `LabelSigningSecret`: production supplies a Cloudflare secret binding, tests a
 * plain string.
 */
export interface NotificationHashPepper {
	get(): Promise<string>;
}

export function getNotificationHashPepper(env: object): NotificationHashPepper {
	const binding: unknown = Reflect.get(env, "NOTIFICATION_HASH_PEPPER");
	if (typeof binding === "string") return { get: async () => binding };
	if (isNotificationHashPepper(binding)) return binding;
	throw new TypeError("NOTIFICATION_HASH_PEPPER is not configured");
}

function isNotificationHashPepper(value: unknown): value is NotificationHashPepper {
	return (
		typeof value === "object" && value !== null && "get" in value && typeof value.get === "function"
	);
}

/**
 * HMAC-SHA256 of the normalized address under `pepper`, as lowercase hex (64
 * chars). Normalization is lowercase + trim only — no provider-specific rules
 * (e.g. Gmail dot/plus folding) per the ratified W10.4 decision. WebCrypto only,
 * so it runs unchanged on workerd.
 */
export async function recipientHash(pepper: string, email: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(pepper),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(email.trim().toLowerCase()),
	);
	return toHex(signature);
}

export async function getContactState(
	db: D1Database,
	recipientHashValue: string,
): Promise<ContactState | null> {
	const row = await db
		.prepare(
			`SELECT recipient_hash, confirm_state, confirm_token_hash,
			 first_seen_at, confirmed_at, last_confirm_sent_at_epoch_ms
			 FROM notification_contacts
			 WHERE recipient_hash = ?`,
		)
		.bind(recipientHashValue)
		.first<ContactRow>();
	return row ? mapContact(row) : null;
}

/** Insert-if-absent as `unconfirmed`; a no-op once the contact exists. */
export async function ensureContact(
	db: D1Database,
	recipientHashValue: string,
	nowIso: string,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO notification_contacts (recipient_hash, confirm_state, first_seen_at)
			 VALUES (?, 'unconfirmed', ?)
			 ON CONFLICT(recipient_hash) DO NOTHING`,
		)
		.bind(recipientHashValue, nowIso)
		.run();
}

/**
 * Record that a confirmation mail was sent: stores the token hash the eventual
 * confirm must match and stamps the send time the rate gate reads.
 */
export async function recordConfirmSent(
	db: D1Database,
	recipientHashValue: string,
	tokenHash: string,
	epochMs: number,
): Promise<void> {
	await db
		.prepare(
			`UPDATE notification_contacts
			 SET confirm_token_hash = ?, last_confirm_sent_at_epoch_ms = ?
			 WHERE recipient_hash = ?`,
		)
		.bind(tokenHash, epochMs, recipientHashValue)
		.run();
}

/**
 * Flip to `confirmed` iff `tokenHash` matches the stored token hash, clearing
 * the token so it cannot be replayed (single-use). Returns whether the flip
 * happened. The provided token is compared in constant time; the conditional
 * UPDATE re-checks the stored hash to close the read-then-write race.
 */
export async function confirmContact(
	db: D1Database,
	recipientHashValue: string,
	tokenHash: string,
	nowIso: string,
): Promise<boolean> {
	const row = await db
		.prepare(`SELECT confirm_token_hash FROM notification_contacts WHERE recipient_hash = ?`)
		.bind(recipientHashValue)
		.first<{ confirm_token_hash: string | null }>();
	if (!row || row.confirm_token_hash === null) return false;
	if (!constantTimeEqual(row.confirm_token_hash, tokenHash)) return false;
	const result = await db
		.prepare(
			`UPDATE notification_contacts
			 SET confirm_state = 'confirmed', confirm_token_hash = NULL, confirmed_at = ?
			 WHERE recipient_hash = ? AND confirm_token_hash = ?`,
		)
		.bind(nowIso, recipientHashValue, row.confirm_token_hash)
		.run();
	return result.meta.changes > 0;
}

/** Mark the contact `declined`, clearing any outstanding confirm token. */
export async function declineContact(db: D1Database, recipientHashValue: string): Promise<void> {
	await db
		.prepare(
			`UPDATE notification_contacts
			 SET confirm_state = 'declined', confirm_token_hash = NULL
			 WHERE recipient_hash = ?`,
		)
		.bind(recipientHashValue)
		.run();
}

export async function isSuppressed(db: D1Database, recipientHashValue: string): Promise<boolean> {
	const row = await db
		.prepare(`SELECT 1 FROM notification_suppressions WHERE recipient_hash = ? LIMIT 1`)
		.bind(recipientHashValue)
		.first<{ 1: number }>();
	return row !== null;
}

/** Idempotent: the first reason recorded for an address wins. */
export async function suppress(
	db: D1Database,
	recipientHashValue: string,
	reason: SuppressionReason,
	nowIso: string,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO notification_suppressions (recipient_hash, reason, created_at, created_at_epoch_ms)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(recipient_hash) DO NOTHING`,
		)
		.bind(recipientHashValue, reason, nowIso, Date.parse(nowIso))
		.run();
}

/**
 * Pure gate for whether a confirmation mail may be sent to a contact: only
 * `unconfirmed` contacts are eligible, and not before `minIntervalMs` has
 * elapsed since the last send. A never-seen contact (`null`) is eligible.
 * Suppression is checked separately by the caller.
 */
export function canSendConfirm(
	row: ContactState | null,
	nowEpochMs: number,
	minIntervalMs: number,
): boolean {
	if (row === null) return true;
	if (row.confirmState !== "unconfirmed") return false;
	if (row.lastConfirmSentAtEpochMs === null) return true;
	return nowEpochMs - row.lastConfirmSentAtEpochMs >= minIntervalMs;
}

function mapContact(row: ContactRow): ContactState {
	return {
		recipientHash: row.recipient_hash,
		confirmState: row.confirm_state,
		confirmTokenHash: row.confirm_token_hash,
		firstSeenAt: row.first_seen_at,
		confirmedAt: row.confirmed_at,
		lastConfirmSentAtEpochMs: row.last_confirm_sent_at_epoch_ms,
	};
}

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let hex = "";
	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return hex;
}

/** Length-guarded XOR compare for the fixed-length hex token hashes. */
function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}
