CREATE TABLE IF NOT EXISTS publisher_notifications (
	id INTEGER PRIMARY KEY,
	run_key TEXT NOT NULL UNIQUE,
	subject_uri TEXT NOT NULL,
	subject_cid TEXT NOT NULL,
	recipients_json TEXT NOT NULL,
	actor_did TEXT NOT NULL,
	actor_role TEXT NOT NULL CHECK (actor_role IN ('reviewer', 'admin')),
	reason TEXT NOT NULL,
	idempotency_key TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
	message_id TEXT,
	error_code TEXT,
	claimed_at TEXT NOT NULL,
	sent_at TEXT
);
