-- Prolonged-error escalation tracking (plan W10.5 follow-up, ratified
-- 2026-07-17). Drives the two-stage escalation ladder the reconciliation cron
-- applies to an assessment stuck in the terminal `error` state (the labeler
-- failed to assess, transient retries exhausted) that no newer run has
-- superseded: at 24h an operator alert (an `operational_events` row) so
-- operators can triage an infra-vs-publisher cause, then at 72h the publisher
-- notice if the error is still the live run.
--
-- One row per escalated assessment makes each stage fire-once across the
-- 5-minute cron ticks: the cron upserts the row, raises the operator alert once
-- when `operator_alerted_at_epoch_ms` is null, and sends the publisher notice
-- once past 72h when `publisher_notified_at_epoch_ms` is null. MUTABLE — the two
-- mark columns flip from null to stamped — so no immutability trigger, mirroring
-- the `notifications`/`notification_outbox` mutable-outbox tables.
--
-- Timestamp columns queries order/compare on carry an integer `*_epoch_ms`
-- sibling (RFC 3339 strings compare incorrectly across timezone offsets in SQL),
-- matching 0003-0008.

CREATE TABLE assessment_error_escalations (
	assessment_id TEXT PRIMARY KEY REFERENCES assessments(id),
	subject_uri TEXT NOT NULL,
	subject_cid TEXT NOT NULL,
	operator_alerted_at_epoch_ms INTEGER,
	publisher_notified_at_epoch_ms INTEGER,
	created_at TEXT NOT NULL,
	created_at_epoch_ms INTEGER NOT NULL
);

-- The escalation scan filters `state = 'error' AND completed_at_epoch_ms <= ?`
-- and orders by `completed_at_epoch_ms`; the existing `idx_assessments_state_created`
-- covers `(state, created_at_epoch_ms)`, not `completed_at`. Partial on the error
-- state keeps this compact (errors are a small minority) and matches the cron's
-- filter and order exactly, so a 5-minute tick seeks instead of full-scanning.
CREATE INDEX idx_assessments_error_completed
	ON assessments(completed_at_epoch_ms) WHERE state = 'error';
