-- Publisher-notification contact state (spec §18/§19, plan W10.4): the
-- double-opt-in ledger for the publisher-facing `notifications` delivery
-- subsystem. Distinct from `notification_outbox` (0005), which is the OPERATOR
-- alert subsystem draining `operational_events` — these two share a name prefix
-- only. Nothing here references an operator table.
--
--   * `notification_contacts`      — one row per recipient, keyed by the
--     HMAC-SHA256 `recipient_hash` (see src/notification-contacts.ts). Holds the
--     confirmation state machine (unconfirmed -> confirmed | declined), the
--     hash of the outstanding confirm token, and the last-confirm-send timestamp
--     the per-address rate gate reads. Mutable, unlike the audit logs: confirm
--     state flips and the token is set then cleared, so it carries no
--     immutability trigger. Plaintext email never lands here — only the
--     HMAC digest — so audit/dedup queries touch hashes only.
--   * `notification_suppressions`  — universal do-not-contact set, keyed by the
--     same `recipient_hash`. A row here suppresses all sends (bounce, complaint,
--     unsubscribe, or "not me"). Idempotent inserts keep the earliest reason.
--
-- `last_confirm_sent_at_epoch_ms` is stored as an integer epoch because the rate
-- gate compares it numerically (RFC 3339 strings compare incorrectly across
-- timezone offsets in SQL), matching the `*_epoch_ms` convention in 0003-0005.
-- `first_seen_at`/`confirmed_at` are audit-only RFC 3339 strings never ordered on.

CREATE TABLE notification_contacts (
	recipient_hash TEXT PRIMARY KEY,
	confirm_state TEXT NOT NULL CHECK (confirm_state IN ('unconfirmed', 'confirmed', 'declined')),
	confirm_token_hash TEXT,
	first_seen_at TEXT NOT NULL,
	confirmed_at TEXT,
	last_confirm_sent_at_epoch_ms INTEGER
);

CREATE TABLE notification_suppressions (
	recipient_hash TEXT PRIMARY KEY,
	reason TEXT NOT NULL CHECK (reason IN ('bounce', 'complaint', 'unsubscribe', 'not_me')),
	created_at TEXT NOT NULL,
	created_at_epoch_ms INTEGER NOT NULL
);
