CREATE TABLE media_quarantine_objects (
	object_key TEXT PRIMARY KEY NOT NULL,
	idempotency_key TEXT UNIQUE,
	sha256 TEXT NOT NULL,
	byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	ready INTEGER NOT NULL DEFAULT 1 CHECK (ready IN (0, 1))
);

CREATE INDEX media_quarantine_expiry
ON media_quarantine_objects(expires_at, object_key);
