CREATE TABLE oauth_values (
	namespace TEXT NOT NULL,
	key TEXT NOT NULL,
	value TEXT NOT NULL,
	PRIMARY KEY (namespace, key)
);

CREATE TABLE oauth_session_leases (
	name TEXT PRIMARY KEY,
	owner TEXT,
	expires_at INTEGER NOT NULL DEFAULT 0
);
