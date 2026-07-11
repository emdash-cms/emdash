ALTER TABLE issued_labels ADD COLUMN signing_key_version TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE issued_labels ADD COLUMN publication_pending INTEGER NOT NULL DEFAULT 0
	CHECK (publication_pending IN (0, 1));

CREATE TABLE signing_state (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	issuer_did TEXT NOT NULL,
	phase TEXT NOT NULL CHECK (phase IN ('active', 'paused')),
	active_key_version TEXT NOT NULL,
	active_public_multikey TEXT NOT NULL,
	pending_key_version TEXT,
	pending_public_multikey TEXT,
	rotation_id TEXT,
	paused_at TEXT,
	activated_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	CHECK (
		(phase = 'active' AND pending_key_version IS NULL AND pending_public_multikey IS NULL)
		OR
		(phase = 'paused' AND pending_key_version IS NOT NULL AND pending_public_multikey IS NOT NULL AND rotation_id IS NOT NULL)
	)
);

CREATE TRIGGER signing_state_immutable_delete
BEFORE DELETE ON signing_state
BEGIN
	SELECT RAISE(ABORT, 'signing state cannot be deleted');
END;

CREATE TABLE signing_key_versions (
	key_version TEXT PRIMARY KEY,
	public_multikey TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'retired', 'aborted')),
	rotation_id TEXT UNIQUE,
	created_at TEXT NOT NULL,
	activated_at TEXT
);

CREATE UNIQUE INDEX signing_key_versions_one_active
ON signing_key_versions(status) WHERE status = 'active';

CREATE TABLE signing_events (
	id INTEGER PRIMARY KEY,
	event_type TEXT NOT NULL CHECK (event_type IN ('transition', 'alert')),
	code TEXT NOT NULL,
	severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
	rotation_id TEXT,
	active_key_version TEXT,
	target_key_version TEXT,
	dedupe_key TEXT UNIQUE,
	created_at TEXT NOT NULL
);

CREATE TRIGGER signing_events_immutable_update
BEFORE UPDATE ON signing_events
BEGIN
	SELECT RAISE(ABORT, 'signing events are immutable');
END;

CREATE TRIGGER signing_events_immutable_delete
BEFORE DELETE ON signing_events
BEGIN
	SELECT RAISE(ABORT, 'signing events are immutable');
END;

CREATE TABLE label_signature_history (
	id INTEGER PRIMARY KEY,
	label_id INTEGER NOT NULL REFERENCES issued_labels(id),
	label_sequence INTEGER NOT NULL,
	sig BLOB NOT NULL,
	signing_key_id TEXT NOT NULL,
	signing_key_version TEXT NOT NULL,
	replaced_at TEXT NOT NULL,
	UNIQUE(label_id, signing_key_version)
);

CREATE TRIGGER label_signature_history_immutable_update
BEFORE UPDATE ON label_signature_history
BEGIN
	SELECT RAISE(ABORT, 'label signature history is immutable');
END;

CREATE TRIGGER label_signature_history_immutable_delete
BEFORE DELETE ON label_signature_history
BEGIN
	SELECT RAISE(ABORT, 'label signature history is immutable');
END;

CREATE INDEX signing_events_created_at ON signing_events(created_at);
CREATE INDEX label_signature_history_sequence ON label_signature_history(label_sequence);
