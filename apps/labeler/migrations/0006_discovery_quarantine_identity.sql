CREATE TABLE IF NOT EXISTS discovery_quarantine_events (
	quarantine_id TEXT PRIMARY KEY NOT NULL,
	cursor TEXT NOT NULL,
	event_id TEXT,
	order_key TEXT NOT NULL,
	reason TEXT NOT NULL,
	event_summary TEXT NOT NULL,
	requires_reconciliation INTEGER NOT NULL CHECK (requires_reconciliation IN (0, 1)),
	event_json TEXT,
	observed_at TEXT NOT NULL,
	revision INTEGER NOT NULL CHECK (revision >= 1)
);

INSERT OR IGNORE INTO discovery_quarantine_events
	(quarantine_id, cursor, event_id, order_key, reason, event_summary,
	 requires_reconciliation, event_json, observed_at, revision)
SELECT
	'legacy:' || cursor,
	cursor,
	NULL,
	'legacy:' || cursor,
	reason,
	event_summary,
	requires_reconciliation,
	event_json,
	observed_at,
	1
FROM discovery_quarantine;

CREATE INDEX IF NOT EXISTS discovery_quarantine_events_reconciliation
ON discovery_quarantine_events(requires_reconciliation, observed_at, cursor, quarantine_id);

CREATE TRIGGER IF NOT EXISTS discovery_quarantine_events_legacy_insert
AFTER INSERT ON discovery_quarantine
BEGIN
	INSERT INTO discovery_quarantine_events
		(quarantine_id, cursor, event_id, order_key, reason, event_summary,
		 requires_reconciliation, event_json, observed_at, revision)
	VALUES
		('legacy:' || NEW.cursor, NEW.cursor, NULL, 'legacy:' || NEW.cursor,
		 NEW.reason, NEW.event_summary, NEW.requires_reconciliation, NEW.event_json,
		 NEW.observed_at, 1)
	ON CONFLICT(quarantine_id) DO UPDATE SET
		reason = excluded.reason,
		event_summary = excluded.event_summary,
		requires_reconciliation = excluded.requires_reconciliation,
		event_json = excluded.event_json,
		observed_at = excluded.observed_at,
		revision = discovery_quarantine_events.revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS discovery_quarantine_events_legacy_update
AFTER UPDATE ON discovery_quarantine
BEGIN
	INSERT INTO discovery_quarantine_events
		(quarantine_id, cursor, event_id, order_key, reason, event_summary,
		 requires_reconciliation, event_json, observed_at, revision)
	VALUES
		('legacy:' || NEW.cursor, NEW.cursor, NULL, 'legacy:' || NEW.cursor,
		 NEW.reason, NEW.event_summary, NEW.requires_reconciliation, NEW.event_json,
		 NEW.observed_at, 1)
	ON CONFLICT(quarantine_id) DO UPDATE SET
		reason = excluded.reason,
		event_summary = excluded.event_summary,
		requires_reconciliation = excluded.requires_reconciliation,
		event_json = excluded.event_json,
		observed_at = excluded.observed_at,
		revision = discovery_quarantine_events.revision + 1;
END;
