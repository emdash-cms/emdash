-- Publisher reconsideration case management (spec §18/§19, plan W10.6). Two
-- tables mirroring the operator_actions(immutable)/notifications(mutable) split:
--
--   * `reconsiderations`      — MUTABLE case, keyed on the subject release
--     (uri + cid) which is STABLE across reruns (a reconsideration is about
--     "this release"; a rerun mints a fresh assessment id). State open →
--     resolved; at most one open case per subject via a partial unique index.
--   * `reconsideration_notes` — APPEND-ONLY private operator notes, immutable
--     like the other audit logs. Kept OFF `operator_actions`, whose `reason` is
--     semi-public (folded into notices/events): a private note must never reach
--     notice copy.
--
-- `triggering_assessment_id` is context only (the assessment the publisher
-- quoted when they wrote in); the case tracks the release, not that run.
--
-- Timestamp columns that queries order on gain an integer `*_epoch_ms` sibling,
-- matching 0003/0004/0005 (RFC 3339 strings compare incorrectly across timezone
-- offsets in SQL).

CREATE TABLE reconsiderations (
	id TEXT PRIMARY KEY,
	subject_uri TEXT NOT NULL,
	subject_cid TEXT NOT NULL,
	triggering_assessment_id TEXT NOT NULL REFERENCES assessments(id),
	state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
	outcome TEXT CHECK (outcome IN ('granted', 'denied', 'withdrawn')),
	opened_by_id TEXT NOT NULL,
	opened_by_email TEXT,
	opened_by_common_name TEXT,
	opened_by_role TEXT NOT NULL CHECK (opened_by_role IN ('admin', 'reviewer')),
	opened_at TEXT NOT NULL,
	opened_at_epoch_ms INTEGER NOT NULL,
	resolved_by_id TEXT,
	resolved_by_email TEXT,
	resolved_by_common_name TEXT,
	resolved_at TEXT,
	resolved_at_epoch_ms INTEGER,
	outcome_action_id TEXT REFERENCES operator_actions(id),
	CHECK (
		(state = 'open' AND outcome IS NULL AND resolved_at IS NULL AND resolved_at_epoch_ms IS NULL
			AND resolved_by_id IS NULL AND outcome_action_id IS NULL)
		OR (state = 'resolved' AND outcome IS NOT NULL AND resolved_at IS NOT NULL
			AND resolved_at_epoch_ms IS NOT NULL AND resolved_by_id IS NOT NULL
			AND outcome_action_id IS NOT NULL)
	)
);

CREATE UNIQUE INDEX idx_reconsiderations_open_subject
	ON reconsiderations(subject_uri, subject_cid) WHERE state = 'open';
CREATE INDEX idx_reconsiderations_state ON reconsiderations(state, opened_at_epoch_ms DESC);
CREATE INDEX idx_reconsiderations_subject
	ON reconsiderations(subject_uri, subject_cid, opened_at_epoch_ms DESC);
CREATE INDEX idx_reconsiderations_opened ON reconsiderations(opened_at_epoch_ms DESC);
CREATE INDEX idx_reconsiderations_outcome_action ON reconsiderations(outcome_action_id)
	WHERE outcome_action_id IS NOT NULL;

CREATE TABLE reconsideration_notes (
	id TEXT PRIMARY KEY,
	reconsideration_id TEXT NOT NULL REFERENCES reconsiderations(id),
	author_id TEXT NOT NULL,
	author_email TEXT,
	author_common_name TEXT,
	author_role TEXT NOT NULL CHECK (author_role IN ('admin', 'reviewer')),
	note TEXT NOT NULL,
	created_at TEXT NOT NULL,
	created_at_epoch_ms INTEGER NOT NULL
);

CREATE TRIGGER reconsideration_notes_immutable_update
BEFORE UPDATE ON reconsideration_notes
BEGIN
	SELECT RAISE(ABORT, 'reconsideration notes are immutable');
END;

CREATE TRIGGER reconsideration_notes_immutable_delete
BEFORE DELETE ON reconsideration_notes
BEGIN
	SELECT RAISE(ABORT, 'reconsideration notes are immutable');
END;

CREATE INDEX idx_reconsideration_notes_case
	ON reconsideration_notes(reconsideration_id, created_at_epoch_ms ASC);
