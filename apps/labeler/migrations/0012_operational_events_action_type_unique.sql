-- At-most-one operational event per (action_id, event_type). An action-scoped
-- event — the emergency alerts, pause/resume, dead-letter controls,
-- reconsideration open/resolve, and the deferred `takedown-no-contact` alert —
-- is emitted once per operator action; this unique index is the hard guarantee
-- behind the check-then-insert emitters, so a concurrent replay that passes the
-- existence check still converges to a single row (paired with ON CONFLICT DO
-- NOTHING on the idempotent insert).
--
-- NULL `action_id` rows (e.g. `assessment-prolonged-error`, keyed off the
-- escalation row instead) are naturally exempt: SQLite treats each NULL as
-- distinct in a UNIQUE index, so it never constrains them.
CREATE UNIQUE INDEX idx_operational_events_action_type
	ON operational_events(action_id, event_type);
