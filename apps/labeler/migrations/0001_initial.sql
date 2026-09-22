CREATE TABLE service_state (
	key TEXT PRIMARY KEY NOT NULL,
	value TEXT NOT NULL,
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE subjects (
	uri TEXT NOT NULL,
	cid TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('profile', 'release')),
	publisher_did TEXT NOT NULL,
	first_observed_at TEXT NOT NULL,
	last_observed_at TEXT NOT NULL,
	deleted_at TEXT,
	PRIMARY KEY (uri, cid)
);

CREATE INDEX subjects_publisher_kind
ON subjects(publisher_did, kind, last_observed_at);

CREATE TABLE current_subjects (
	uri TEXT PRIMARY KEY NOT NULL,
	cid TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('profile', 'release')),
	updated_at TEXT NOT NULL,
	deleted_at TEXT,
	FOREIGN KEY (uri, cid) REFERENCES subjects(uri, cid)
);

CREATE TABLE assessments (
	id TEXT PRIMARY KEY NOT NULL,
	run_key TEXT NOT NULL UNIQUE,
	subject_uri TEXT NOT NULL,
	subject_cid TEXT NOT NULL,
	subject_kind TEXT NOT NULL CHECK (subject_kind IN ('profile', 'release')),
	policy_version TEXT NOT NULL,
	parser_version TEXT NOT NULL,
	text_model_id TEXT NOT NULL,
	text_prompt_hash TEXT NOT NULL,
	image_model_id TEXT NOT NULL,
	image_prompt_hash TEXT NOT NULL,
	logical_trigger_id TEXT NOT NULL,
	state TEXT NOT NULL CHECK (
		state IN ('pending', 'running', 'passed', 'review', 'blocked', 'error', 'superseded', 'cancelled')
	),
	state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
	moderation_fingerprint TEXT,
	coverage_json TEXT,
	canonical_input_json TEXT,
	summary_json TEXT,
	error_code TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	started_at TEXT,
	completed_at TEXT,
	cancelled_at TEXT,
	FOREIGN KEY (subject_uri, subject_cid) REFERENCES subjects(uri, cid)
);

CREATE INDEX assessments_subject_created
ON assessments(subject_uri, subject_cid, created_at DESC);

CREATE INDEX assessments_state_updated
ON assessments(state, updated_at);

CREATE TABLE findings (
	id INTEGER PRIMARY KEY,
	assessment_id TEXT NOT NULL REFERENCES assessments(id),
	category TEXT NOT NULL,
	confidence REAL,
	reason_code TEXT NOT NULL,
	public_summary TEXT NOT NULL,
	evidence_refs_json TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX findings_assessment
ON findings(assessment_id, id);

CREATE TABLE current_assessments (
	subject_uri TEXT NOT NULL,
	subject_cid TEXT NOT NULL,
	assessment_id TEXT NOT NULL UNIQUE REFERENCES assessments(id),
	updated_at TEXT NOT NULL,
	PRIMARY KEY (subject_uri, subject_cid),
	FOREIGN KEY (subject_uri, subject_cid) REFERENCES subjects(uri, cid)
);

CREATE TABLE operator_actions (
	id INTEGER PRIMARY KEY,
	actor_did TEXT NOT NULL,
	actor_role TEXT NOT NULL CHECK (actor_role IN ('reviewer', 'admin')),
	action TEXT NOT NULL CHECK (
		action IN (
			'approve',
			'block',
			'rerun',
			'takedown',
			'retract-takedown',
			'pause-issuance',
			'resume-issuance'
		)
	),
	subject_uri TEXT,
	subject_cid TEXT,
	reason TEXT NOT NULL,
	idempotency_key TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL,
	CHECK (
		(action IN ('pause-issuance', 'resume-issuance') AND subject_uri IS NULL AND subject_cid IS NULL)
		OR
		(action NOT IN ('pause-issuance', 'resume-issuance') AND subject_uri IS NOT NULL)
	)
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

CREATE TABLE label_sequence (
	name TEXT PRIMARY KEY CHECK (name = 'issued_labels'),
	next_sequence INTEGER NOT NULL CHECK (next_sequence > 0)
);

INSERT INTO label_sequence (name, next_sequence) VALUES ('issued_labels', 1);

CREATE TABLE issued_labels (
	id INTEGER PRIMARY KEY,
	idempotency_key TEXT NOT NULL UNIQUE,
	assessment_id TEXT REFERENCES assessments(id),
	assessment_policy_version TEXT,
	assessment_outcome TEXT CHECK (
		assessment_outcome IN ('pending', 'passed', 'review', 'error')
	),
	operator_action_id INTEGER REFERENCES operator_actions(id),
	actor_did TEXT NOT NULL,
	actor_role TEXT NOT NULL CHECK (actor_role IN ('automation', 'reviewer', 'admin')),
	reason TEXT NOT NULL,
	sequence INTEGER UNIQUE CHECK (sequence > 0),
	ver INTEGER NOT NULL CHECK (ver = 1),
	src TEXT NOT NULL,
	uri TEXT NOT NULL,
	cid TEXT,
	val TEXT NOT NULL CHECK (
		val IN (
			'listing-passed',
			'listing-pending',
			'listing-review',
			'listing-error',
			'listing-blocked',
			'listing-overridden',
			'!takedown'
		)
	),
	neg INTEGER NOT NULL DEFAULT 0 CHECK (neg IN (0, 1)),
	cts TEXT NOT NULL,
	exp TEXT,
	sig BLOB NOT NULL,
	signing_key_id TEXT NOT NULL,
	publication_pending INTEGER NOT NULL DEFAULT 1 CHECK (publication_pending IN (0, 1)),
	created_at TEXT NOT NULL,
	CHECK (
		(val = '!takedown' AND cid IS NULL)
		OR (val <> '!takedown' AND cid IS NOT NULL)
	),
	CHECK (
		actor_role <> 'automation'
		OR val IN ('listing-passed', 'listing-pending', 'listing-review', 'listing-error')
	),
	CHECK (
		(actor_role = 'automation' AND assessment_id IS NOT NULL
		 AND assessment_policy_version IS NOT NULL AND assessment_outcome IS NOT NULL)
		OR
		(actor_role <> 'automation' AND assessment_id IS NULL
		 AND assessment_policy_version IS NULL AND assessment_outcome IS NULL)
	)
);

CREATE TRIGGER issued_labels_allocate_sequence
AFTER INSERT ON issued_labels
WHEN NEW.sequence IS NULL
BEGIN
	UPDATE issued_labels
	SET sequence = (SELECT next_sequence FROM label_sequence WHERE name = 'issued_labels')
	WHERE id = NEW.id;
	UPDATE label_sequence
	SET next_sequence = next_sequence + 1
	WHERE name = 'issued_labels';
END;

CREATE TRIGGER issued_labels_immutable_fields
BEFORE UPDATE OF
	id,
	idempotency_key,
	assessment_id,
	assessment_policy_version,
	assessment_outcome,
	operator_action_id,
	actor_did,
	actor_role,
	reason,
	ver,
	src,
	uri,
	cid,
	val,
	neg,
	cts,
	exp,
	sig,
	signing_key_id,
	created_at
ON issued_labels
BEGIN
	SELECT RAISE(ABORT, 'issued label contents are immutable');
END;

CREATE TRIGGER issued_labels_sequence_once
BEFORE UPDATE OF sequence ON issued_labels
WHEN OLD.sequence IS NOT NULL OR NEW.sequence IS NULL
BEGIN
	SELECT RAISE(ABORT, 'issued label sequence is immutable');
END;

CREATE TRIGGER issued_labels_immutable_delete
BEFORE DELETE ON issued_labels
BEGIN
	SELECT RAISE(ABORT, 'issued labels are immutable');
END;

CREATE INDEX issued_labels_query_order
ON issued_labels(sequence);

CREATE INDEX issued_labels_uri_sequence
ON issued_labels(uri, sequence);

CREATE INDEX issued_labels_source_sequence
ON issued_labels(src, sequence);

CREATE INDEX issued_labels_publication_pending
ON issued_labels(sequence) WHERE publication_pending = 1;

CREATE TABLE ingest_state (
	stream TEXT PRIMARY KEY NOT NULL,
	cursor TEXT,
	last_observed_at TEXT,
	updated_at TEXT NOT NULL
);
