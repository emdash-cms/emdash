-- At-most-one `takedown-no-contact` operational event per action. That deferred
-- alert is raised from a fire-and-forget tail with a check-then-insert, so a
-- concurrent replay could double-emit; this unique index is the hard guarantee
-- that collapses them to one row (paired with ON CONFLICT DO NOTHING on the
-- insert).
--
-- PARTIAL, scoped to `takedown-no-contact` only: the prior schema allowed
-- duplicate (action_id, event_type) rows and historical data may hold them for
-- OTHER event types, which a global unique index would reject at migration time.
-- Restricting the predicate to the one event type that needs the guarantee keeps
-- the migration safe on existing data while still enforcing the dedup we require.
CREATE UNIQUE INDEX idx_operational_events_takedown_no_contact
	ON operational_events(action_id, event_type)
	WHERE event_type = 'takedown-no-contact';
