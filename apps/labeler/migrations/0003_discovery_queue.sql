CREATE TABLE discovery_deliveries (
	delivery_id TEXT PRIMARY KEY NOT NULL,
	cursor TEXT NOT NULL,
	processed_at TEXT NOT NULL
);

CREATE TABLE discovery_quarantine (
	cursor TEXT PRIMARY KEY NOT NULL,
	reason TEXT NOT NULL,
	event_summary TEXT NOT NULL,
	requires_reconciliation INTEGER NOT NULL CHECK (requires_reconciliation IN (0, 1)),
	event_json TEXT,
	observed_at TEXT NOT NULL
);

CREATE TABLE discovery_subject_cursors (
	uri TEXT PRIMARY KEY NOT NULL,
	cursor TEXT NOT NULL,
	order_key TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
