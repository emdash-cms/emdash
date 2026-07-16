-- Publisher-facing notification delivery (spec §14.4/§18/§19, plan W10.5). This
-- is the MUTABLE outbox the send path drives per recipient, distinct from both
-- `notification_outbox` (0005 — the OPERATOR alert subsystem) and the
-- `notification_contacts`/`notification_suppressions` double-opt-in ledger (0007,
-- which this send path reads). Two tables land together:
--
--   * `notifications`              — one row per delivery attempt, keyed by ULID.
--     A row is claimed `pending`, then flipped to `sent` (with `provider_id` and
--     `sent_at` set, `plaintext_email` CLEARED to NULL) or `failed`/`undeliverable`
--     (with `last_error`, `attempts` bumped). Mutable — a failed send is retried
--     independently and NEVER rolls back a label, so no immutability trigger. The
--     trigger is referenced polymorphically by (`source_type`, `source_id`): there
--     is NO SQL FK because the source is one of two audit tables (`issuance_actions`
--     for automated block/warning/retraction, `operator_actions` for override/
--     emergency); the writer enforces referential integrity.
--   * `notification_confirm_ledger` — per-DID confirmation-send ledger. Per-address
--     rate limiting lives on `notification_contacts.last_confirm_sent_at_epoch_ms`,
--     but that does NOT cap a hostile publisher DID naming many DISTINCT victim
--     addresses. This ledger records one row per confirmation mail so the send path
--     can count DISTINCT recipients per DID in a rolling window before sending, and
--     prune rows below the window. Keyed by ULID; no plaintext, hashes only.
--
-- `plaintext_email` is the ONLY plaintext in the subsystem (0007 stores hashes
-- only): a delivery row must hold the address until the mail is handed to the
-- provider, then clears it on success. Undelivered rows are swept after a
-- versioned retention window (W10.5 slice 2 cron), so plaintext for a failed send
-- does not linger indefinitely.
--
-- Timestamp columns queries order/compare on gain an integer `*_epoch_ms` sibling
-- (RFC 3339 strings compare incorrectly across timezone offsets in SQL), matching
-- 0003-0007. `created_at`/`sent_at` are RFC 3339 audit strings; `created_at_epoch_ms`
-- is what the retention sweep orders on.

CREATE TABLE notifications (
	id TEXT PRIMARY KEY,
	source_type TEXT NOT NULL CHECK (source_type IN ('issuance', 'operator')),
	source_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('confirmation', 'notice')),
	channel TEXT NOT NULL DEFAULT 'email',
	-- NULL only on a no-resolvable-contact `undeliverable` audit row, where no
	-- address (hence no hash) exists. Every row that was actually sendable carries
	-- the HMAC-SHA256 recipient hash.
	recipient_hash TEXT,
	state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'failed', 'undeliverable')),
	attempts INTEGER NOT NULL DEFAULT 0,
	provider_id TEXT,
	last_error TEXT,
	plaintext_email TEXT,
	created_at TEXT NOT NULL,
	created_at_epoch_ms INTEGER NOT NULL,
	sent_at TEXT,
	-- Only a no-resolvable-contact `undeliverable` audit row may omit the hash;
	-- every sendable row (pending/sent/failed) must carry one.
	CHECK (state = 'undeliverable' OR recipient_hash IS NOT NULL)
);

CREATE INDEX idx_notifications_pending ON notifications(state, created_at_epoch_ms)
	WHERE state IN ('pending', 'failed');
CREATE INDEX idx_notifications_created ON notifications(created_at_epoch_ms);
CREATE INDEX idx_notifications_recipient ON notifications(recipient_hash);
CREATE INDEX idx_notifications_source ON notifications(source_type, source_id);

CREATE TABLE notification_confirm_ledger (
	id TEXT PRIMARY KEY,
	publisher_did TEXT NOT NULL,
	recipient_hash TEXT NOT NULL,
	sent_at_epoch_ms INTEGER NOT NULL
);

CREATE INDEX idx_notification_confirm_ledger_did
	ON notification_confirm_ledger(publisher_did, sent_at_epoch_ms);
CREATE INDEX idx_notification_confirm_ledger_sweep
	ON notification_confirm_ledger(sent_at_epoch_ms);
