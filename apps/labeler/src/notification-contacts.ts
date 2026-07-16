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
	const key = await getHmacKey(pepper);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(email.trim().toLowerCase()),
	);
	return toHex(signature);
}

/**
 * Cache the imported HMAC key per pepper on `globalThis` (Vite can duplicate a
 * module across chunks; a plain module-scope `Map` would become two caches —
 * see the xrpc-router precedent). The promise is cached so concurrent first
 * callers share one `importKey`.
 */
const HMAC_KEY_CACHE_KEY = Symbol.for("emdash:labeler-notification-hmac-keys");
const hmacKeyGlobal = globalThis as Record<symbol, unknown>;
function getHmacKey(pepper: string): Promise<CryptoKey> {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern (see core request-cache.ts)
	let cache = hmacKeyGlobal[HMAC_KEY_CACHE_KEY] as Map<string, Promise<CryptoKey>> | undefined;
	if (!cache) {
		cache = new Map();
		hmacKeyGlobal[HMAC_KEY_CACHE_KEY] = cache;
	}
	let key = cache.get(pepper);
	if (!key) {
		key = crypto.subtle.importKey(
			"raw",
			encoder.encode(pepper),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		cache.set(pepper, key);
	}
	return key;
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
 * confirm must match and stamps the send time the rate gate reads. Only touches
 * an `unconfirmed` contact — a confirmed or declined row is never reopened even
 * if a caller skips {@link canSendConfirm}. Returns whether a row was updated.
 */
export async function recordConfirmSent(
	db: D1Database,
	recipientHashValue: string,
	tokenHash: string,
	epochMs: number,
): Promise<boolean> {
	if (!Number.isFinite(epochMs)) {
		throw new TypeError("recordConfirmSent requires a finite epochMs");
	}
	const result = await db
		.prepare(
			`UPDATE notification_contacts
			 SET confirm_token_hash = ?, last_confirm_sent_at_epoch_ms = ?
			 WHERE recipient_hash = ? AND confirm_state = 'unconfirmed'`,
		)
		.bind(tokenHash, epochMs, recipientHashValue)
		.run();
	return result.meta.changes > 0;
}

/**
 * Flip to `confirmed` iff `tokenHash` matches the stored token hash, clearing
 * the token so it cannot be replayed (single-use). Returns whether the flip
 * happened. The provided token is compared in constant time against the stored
 * hash — or a fixed-length dummy when the row is missing or has no token — so
 * elapsed time never reveals whether the recipient or a pending token exists.
 * The conditional UPDATE re-checks the stored hash and `unconfirmed` state to
 * close the read-then-write race, so a stale token can never flip a
 * declined/confirmed row.
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
	const stored = row?.confirm_token_hash ?? ABSENT_TOKEN_HASH;
	const matches = constantTimeEqual(stored, tokenHash);
	if (!row || row.confirm_token_hash === null || !matches) return false;
	const result = await db
		.prepare(
			`UPDATE notification_contacts
			 SET confirm_state = 'confirmed', confirm_token_hash = NULL, confirmed_at = ?
			 WHERE recipient_hash = ? AND confirm_token_hash = ? AND confirm_state = 'unconfirmed'`,
		)
		.bind(nowIso, recipientHashValue, row.confirm_token_hash)
		.run();
	return result.meta.changes > 0;
}

/**
 * Decline the pending confirmation, clearing any outstanding token. Only touches
 * an `unconfirmed` contact — a confirmed opt-in is never revoked here (that goes
 * through {@link suppress}), so an unsubscribe-path bug can't downgrade it.
 * Returns whether a row was updated.
 */
export async function declineContact(db: D1Database, recipientHashValue: string): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE notification_contacts
			 SET confirm_state = 'declined', confirm_token_hash = NULL
			 WHERE recipient_hash = ? AND confirm_state = 'unconfirmed'`,
		)
		.bind(recipientHashValue)
		.run();
	return result.meta.changes > 0;
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
	epochMs: number,
): Promise<void> {
	if (!Number.isFinite(epochMs)) {
		throw new TypeError("suppress requires a finite epochMs");
	}
	await db
		.prepare(
			`INSERT INTO notification_suppressions (recipient_hash, reason, created_at, created_at_epoch_ms)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(recipient_hash) DO NOTHING`,
		)
		.bind(recipientHashValue, reason, nowIso, epochMs)
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

/**
 * Stand-in stored hash for `confirmContact` when the row or token is absent, so
 * the constant-time compare always runs. 64 hex chars — the SHA-256 token-hash
 * length — so the length guard never short-circuits for a well-formed token.
 */
const ABSENT_TOKEN_HASH = "0".repeat(64);

/** Length-guarded XOR compare for the fixed-length hex token hashes. */
function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}
