-- Operational-alert subsystem (spec §11.3/§18.2/§22). Three concerns land
-- together so later W9.6 PRs are code-only:
--
--   * `operational_events`  — append-only operator/deployment alert stream,
--     the source of truth W11.3 alarms read (severity IN ('critical','high')).
--     Distinct from `operator_actions` (who did what) and the publisher-facing
--     `notifications` table (W10). Written atomically with the operator_actions
--     row + the effect by `commitMutation`; immutable like the other audit logs.
--   * `notification_outbox` — mutable per-(event, channel) delivery state W11.3
--     drains and flips. Mirrors the operator_actions(immutable)/notifications
--     (mutable) split: a delivery failure never rolls back the event or label.
--   * `automation_state`    — the singleton ingestion kill-switch (id = 1,
--     mirroring `signing_state`), checked by the discovery consumer.
--
-- The `dead_letters` ALTERs (forward-only, additive) give operators retry /
-- quarantine controls without recreating the table.
--
-- Timestamp columns that queries order on gain an integer `*_epoch_ms`
-- sibling, matching 0003/0004 (RFC 3339 strings compare incorrectly across
-- timezone offsets in SQL).

CREATE TABLE operational_events (
	id TEXT PRIMARY KEY,
	event_type TEXT NOT NULL,
	severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'info')),
	action_id TEXT REFERENCES operator_actions(id),
	subject_uri TEXT,
	label_value TEXT,
	payload_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	created_at_epoch_ms INTEGER NOT NULL
);

CREATE TRIGGER operational_events_immutable_update
BEFORE UPDATE ON operational_events
BEGIN
	SELECT RAISE(ABORT, 'operational events are immutable');
END;

CREATE TRIGGER operational_events_immutable_delete
BEFORE DELETE ON operational_events
BEGIN
	SELECT RAISE(ABORT, 'operational events are immutable');
END;

CREATE INDEX idx_operational_events_created ON operational_events(created_at_epoch_ms DESC);
CREATE INDEX idx_operational_events_severity
	ON operational_events(severity, created_at_epoch_ms DESC);
CREATE INDEX idx_operational_events_action ON operational_events(action_id)
	WHERE action_id IS NOT NULL;

CREATE TABLE notification_outbox (
	id TEXT PRIMARY KEY,
	event_id TEXT NOT NULL REFERENCES operational_events(id),
	channel TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'failed')),
	attempts INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	created_at TEXT NOT NULL,
	created_at_epoch_ms INTEGER NOT NULL,
	sent_at TEXT
);

CREATE INDEX idx_notification_outbox_pending
	ON notification_outbox(state, created_at_epoch_ms) WHERE state = 'pending';
CREATE INDEX idx_notification_outbox_event ON notification_outbox(event_id);

CREATE TABLE automation_state (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
	paused_reason TEXT,
	paused_by_action_id TEXT REFERENCES operator_actions(id),
	updated_at TEXT NOT NULL,
	updated_at_epoch_ms INTEGER NOT NULL
);

INSERT INTO automation_state (id, paused, updated_at, updated_at_epoch_ms)
	VALUES (1, 0, '1970-01-01T00:00:00.000Z', 0);

ALTER TABLE dead_letters ADD COLUMN status TEXT NOT NULL DEFAULT 'new'
	CHECK (status IN ('new', 'retried', 'quarantined'));
ALTER TABLE dead_letters ADD COLUMN resolved_at TEXT;
ALTER TABLE dead_letters ADD COLUMN resolved_by_action_id TEXT REFERENCES operator_actions(id);

CREATE INDEX idx_dead_letters_status ON dead_letters(status, received_at);
CREATE INDEX idx_dead_letters_resolved_action ON dead_letters(resolved_by_action_id)
	WHERE resolved_by_action_id IS NOT NULL;
