-- Immutable operator-action audit log (spec §12/§14.4/§22): one append-only
-- row per state-changing operator mutation, written atomically with the
-- mutation's effect by `commitMutation`. Distinct from `issuance_actions`
-- (the signing-layer record, keyed by the labeler DID): this answers "which
-- operator did what, under which role, why" — including actions that issue no
-- label at all (rerun, pause/resume, DLQ controls). `id` is the
-- `operatorTriggerId` anchor a rerun (§7) attaches to.
--
-- Timestamp columns that queries order on gain an integer `*_epoch_ms`
-- sibling, matching 0003 (RFC 3339 strings compare incorrectly across
-- timezone offsets in SQL).

CREATE TABLE operator_actions (
	id TEXT PRIMARY KEY,
	actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'service')),
	actor_id TEXT NOT NULL,
	actor_email TEXT,
	actor_common_name TEXT,
	role TEXT NOT NULL CHECK (role IN ('admin', 'reviewer')),
	action TEXT NOT NULL,
	subject_uri TEXT,
	subject_cid TEXT,
	label_value TEXT,
	reason TEXT NOT NULL,
	idempotency_key TEXT NOT NULL UNIQUE,
	request_fingerprint TEXT NOT NULL,
	result_json TEXT,
	metadata_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	created_at_epoch_ms INTEGER NOT NULL
);

CREATE TRIGGER operator_actions_immutable_update
BEFORE UPDATE ON operator_actions
BEGIN
	SELECT RAISE(ABORT, 'operator actions are immutable');
END;

CREATE TRIGGER operator_actions_immutable_delete
BEFORE DELETE ON operator_actions
BEGIN
	SELECT RAISE(ABORT, 'operator actions are immutable');
END;

CREATE INDEX idx_operator_actions_created ON operator_actions(created_at_epoch_ms DESC);
CREATE INDEX idx_operator_actions_subject
	ON operator_actions(subject_uri, subject_cid, created_at_epoch_ms DESC);
CREATE INDEX idx_operator_actions_actor
	ON operator_actions(actor_id, created_at_epoch_ms DESC);
