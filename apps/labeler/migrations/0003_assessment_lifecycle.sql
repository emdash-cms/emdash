-- Assessment lifecycle persistence: verified subjects, immutable assessment
-- runs, the current-assessment pointer, findings/evidence metadata, and the
-- schema-only prep tables PR B's discovery consumer needs (dead_letters,
-- ingest_state).
--
-- Timestamp columns that queries compare gain an integer `*_epoch_ms`
-- sibling, matching apps/aggregator/migrations/0003_label_history_identity.sql
-- (RFC 3339 strings compare incorrectly across timezone offsets in SQL).
-- `issuance_actions`/`issued_labels`/`label_sequence` already exist from prior
-- migrations and stand in for spec §14's `actions`/`issued_labels`/
-- `label_sequence`; this migration extends `issuance_actions` with the column
-- an automated-assessment action needs rather than recreating that table.

CREATE TABLE subjects (
	uri TEXT NOT NULL,
	cid TEXT NOT NULL,
	did TEXT NOT NULL,
	collection TEXT NOT NULL,
	rkey TEXT NOT NULL,
	observed_at TEXT NOT NULL,
	observed_at_epoch_ms INTEGER NOT NULL,
	deleted_at TEXT,
	deleted_at_epoch_ms INTEGER,
	PRIMARY KEY (uri, cid)
);

CREATE INDEX idx_subjects_did ON subjects(did);

CREATE TABLE assessments (
	id TEXT PRIMARY KEY,
	run_key TEXT NOT NULL UNIQUE,
	uri TEXT NOT NULL,
	cid TEXT NOT NULL,
	artifact_id TEXT,
	artifact_checksum TEXT,
	state TEXT NOT NULL CHECK (state IN (
		'observed', 'verifying', 'pending', 'running',
		'passed', 'warned', 'blocked', 'error', 'stale', 'cancelled'
	)),
	trigger TEXT NOT NULL,
	trigger_id TEXT NOT NULL,
	policy_version TEXT NOT NULL,
	model_id TEXT,
	prompt_hash TEXT,
	scanner_versions_json TEXT NOT NULL,
	public_summary TEXT,
	coverage_json TEXT NOT NULL,
	supersedes_assessment_id TEXT REFERENCES assessments(id),
	started_at TEXT,
	started_at_epoch_ms INTEGER,
	completed_at TEXT,
	completed_at_epoch_ms INTEGER,
	created_at TEXT NOT NULL,
	created_at_epoch_ms INTEGER NOT NULL,
	FOREIGN KEY (uri, cid) REFERENCES subjects(uri, cid)
);

CREATE INDEX idx_assessments_state_created ON assessments(state, created_at_epoch_ms DESC);
CREATE INDEX idx_assessments_subject ON assessments(uri, cid, created_at_epoch_ms DESC);
CREATE INDEX idx_assessments_supersedes ON assessments(supersedes_assessment_id);

CREATE TABLE current_assessments (
	src TEXT NOT NULL,
	uri TEXT NOT NULL,
	cid TEXT NOT NULL,
	assessment_id TEXT NOT NULL REFERENCES assessments(id),
	updated_at TEXT NOT NULL,
	PRIMARY KEY (src, uri, cid)
);

CREATE INDEX idx_current_assessments_assessment ON current_assessments(assessment_id);

CREATE TABLE findings (
	id TEXT PRIMARY KEY,
	assessment_id TEXT NOT NULL REFERENCES assessments(id),
	source TEXT NOT NULL,
	category TEXT NOT NULL,
	severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
	confidence REAL,
	title TEXT NOT NULL,
	public_summary TEXT NOT NULL,
	private_detail TEXT NOT NULL,
	evidence_refs_json TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX idx_findings_assessment ON findings(assessment_id);

CREATE TABLE evidence_objects (
	id TEXT PRIMARY KEY,
	assessment_id TEXT NOT NULL REFERENCES assessments(id),
	kind TEXT NOT NULL,
	sha256 TEXT NOT NULL,
	r2_key TEXT,
	metadata_json TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX idx_evidence_objects_assessment ON evidence_objects(assessment_id);

-- Links an automated-assessment issuance action back to the run that
-- produced it. Nullable: manual-label actions never set this.
ALTER TABLE issuance_actions ADD COLUMN assessment_id TEXT REFERENCES assessments(id);

CREATE INDEX idx_issuance_actions_assessment ON issuance_actions(assessment_id)
	WHERE assessment_id IS NOT NULL;

-- Covers the §10 automated-negation guard's per-stream head lookup
-- (latest label for a given src+uri+val), which runs on every automated
-- negation and would otherwise filter many rows as a subject's stream grows.
CREATE INDEX idx_issued_labels_stream ON issued_labels(src, uri, val, sequence);

-- Schema-only prep for PR B's Jetstream discovery consumer; shape matches
-- apps/aggregator/migrations/0001_init.sql's dead_letters/ingest_state.
CREATE TABLE dead_letters (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	did TEXT NOT NULL,
	collection TEXT NOT NULL,
	rkey TEXT NOT NULL,
	reason TEXT NOT NULL,
	detail TEXT,
	payload BLOB NOT NULL,
	received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_dead_letters_did ON dead_letters(did);
CREATE INDEX idx_dead_letters_received ON dead_letters(received_at);

CREATE TABLE ingest_state (
	source TEXT PRIMARY KEY,
	cursor TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
