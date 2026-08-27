export function initializeApproverSchema(storage: DurableObjectStorage): void {
	storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS approver (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			did TEXT NOT NULL UNIQUE,
			status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
			session_epoch INTEGER NOT NULL DEFAULT 1 CHECK (session_epoch >= 1),
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS identity_transactions (
			state_hash TEXT PRIMARY KEY,
			encrypted_state TEXT NOT NULL,
			encryption_key_version INTEGER NOT NULL CHECK (encryption_key_version >= 1),
			client_key_id TEXT NOT NULL,
			redirect_target TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			completed_at INTEGER,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_approver_identity_expiry
			ON identity_transactions(expires_at, state_hash);
		CREATE TABLE IF NOT EXISTS approver_sessions (
			token_hash TEXT PRIMARY KEY,
			csrf_hash TEXT NOT NULL,
			session_epoch INTEGER NOT NULL CHECK (session_epoch >= 1),
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			last_seen_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_approver_sessions_expiry
			ON approver_sessions(expires_at, token_hash);
		CREATE TABLE IF NOT EXISTS credentials (
			credential_id TEXT PRIMARY KEY,
			public_key BLOB NOT NULL,
			algorithm INTEGER NOT NULL CHECK (algorithm IN (-7, -257)),
			signature_counter INTEGER NOT NULL CHECK (signature_counter >= 0),
			transports_json TEXT NOT NULL,
			name TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			last_used_at INTEGER,
			revoked_at INTEGER,
			CHECK (last_used_at IS NULL OR last_used_at >= created_at),
			CHECK (revoked_at IS NULL OR revoked_at >= created_at)
		);
		CREATE INDEX IF NOT EXISTS idx_approver_credentials_status
			ON credentials(revoked_at, created_at, credential_id);
		CREATE TABLE IF NOT EXISTS approval_challenges (
			challenge_hash TEXT PRIMARY KEY,
			kind TEXT NOT NULL CHECK (kind IN ('registration', 'approval')),
			intent_id TEXT,
			publisher_did TEXT,
			approval_digest TEXT,
			context TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			consumed_at INTEGER,
			created_at INTEGER NOT NULL,
			CHECK (
				(kind = 'registration' AND intent_id IS NULL AND publisher_did IS NULL AND approval_digest IS NULL)
				OR
				(kind = 'approval' AND intent_id IS NOT NULL AND publisher_did IS NOT NULL AND approval_digest IS NOT NULL)
			),
			CHECK (consumed_at IS NULL OR consumed_at >= created_at)
		);
		CREATE INDEX IF NOT EXISTS idx_approval_challenges_expiry
			ON approval_challenges(expires_at, challenge_hash);
		CREATE INDEX IF NOT EXISTS idx_approval_challenges_intent
			ON approval_challenges(intent_id, consumed_at, expires_at);
		CREATE TABLE IF NOT EXISTS decisions (
			idempotency_key TEXT PRIMARY KEY,
			intent_id TEXT NOT NULL,
			publisher_did TEXT NOT NULL,
			approval_digest TEXT NOT NULL,
			decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
			credential_id TEXT NOT NULL,
			verified_at INTEGER NOT NULL,
			receipt_json TEXT NOT NULL,
			UNIQUE(intent_id, approval_digest)
		);
		CREATE INDEX IF NOT EXISTS idx_approver_decisions_intent
			ON decisions(intent_id, verified_at);
		CREATE TABLE IF NOT EXISTS audit_events (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			event_type TEXT NOT NULL,
			actor_realm TEXT NOT NULL CHECK (actor_realm IN ('access', 'approver', 'system')),
			actor_identity TEXT NOT NULL,
			subject TEXT NOT NULL,
			reason_code TEXT,
			public_payload TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS deadlines (
			kind TEXT NOT NULL CHECK (kind IN ('challenge', 'session', 'identity')),
			subject_id TEXT NOT NULL,
			generation INTEGER NOT NULL CHECK (generation >= 1),
			scheduled_at INTEGER NOT NULL,
			PRIMARY KEY (kind, subject_id)
		);
		CREATE INDEX IF NOT EXISTS idx_approver_deadlines_due
			ON deadlines(scheduled_at, kind, subject_id);
	`);
}
