CREATE TABLE publisher_accounts (
	did TEXT PRIMARY KEY,
	handle TEXT,
	pds_url TEXT,
	pds_resolved_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE oauth_transactions (
	id TEXT PRIMARY KEY,
	state_hash TEXT NOT NULL UNIQUE,
	purpose TEXT NOT NULL CHECK (purpose IN ('console_login', 'approver_identity', 'release_delegation')),
	expected_did TEXT,
	client_key_id TEXT NOT NULL,
	encrypted_state TEXT NOT NULL,
	encryption_key_version INTEGER NOT NULL,
	redirect_target TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX idx_oauth_transactions_purpose_expiry
	ON oauth_transactions(purpose, expires_at);
CREATE INDEX idx_oauth_transactions_expected_did
	ON oauth_transactions(expected_did, purpose);

CREATE TABLE console_sessions (
	id TEXT PRIMARY KEY,
	token_hash TEXT NOT NULL UNIQUE,
	publisher_did TEXT NOT NULL,
	encrypted_csrf_secret TEXT NOT NULL,
	encryption_key_version INTEGER NOT NULL,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	FOREIGN KEY (publisher_did) REFERENCES publisher_accounts(did) ON DELETE CASCADE
);

CREATE INDEX idx_console_sessions_owner_expiry
	ON console_sessions(publisher_did, expires_at);

CREATE TABLE delegations (
	id TEXT PRIMARY KEY,
	publisher_did TEXT NOT NULL,
	release_nsid TEXT NOT NULL,
	encrypted_session TEXT,
	encryption_key_version INTEGER,
	client_key_id TEXT NOT NULL,
	scope TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('active', 'refreshing', 'reauthorization_required', 'revoked')),
	state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version >= 1),
	lease_owner TEXT,
	lease_expires_at TEXT,
	last_refreshed_at TEXT,
	refresh_before TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	revoked_at TEXT,
	FOREIGN KEY (publisher_did) REFERENCES publisher_accounts(did) ON DELETE CASCADE,
	CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
	CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
	CHECK (encrypted_session IS NOT NULL OR status = 'revoked')
);

CREATE UNIQUE INDEX idx_delegations_active_grant
	ON delegations(publisher_did, release_nsid)
	WHERE revoked_at IS NULL;
CREATE INDEX idx_delegations_owner_status
	ON delegations(publisher_did, status);
CREATE INDEX idx_delegations_refresh_before
	ON delegations(refresh_before)
	WHERE status = 'active' AND refresh_before IS NOT NULL;
CREATE INDEX idx_delegations_lease_expiry
	ON delegations(lease_expires_at)
	WHERE status = 'refreshing';
