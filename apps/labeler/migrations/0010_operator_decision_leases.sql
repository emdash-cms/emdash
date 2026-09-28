CREATE TABLE IF NOT EXISTS operator_decision_leases (
	subject_uri TEXT NOT NULL,
	subject_cid TEXT NOT NULL,
	lease_token TEXT NOT NULL,
	lease_expires_at TEXT NOT NULL,
	PRIMARY KEY (subject_uri, subject_cid)
);

CREATE INDEX IF NOT EXISTS operator_decision_leases_expiry
	ON operator_decision_leases(lease_expires_at, subject_uri, subject_cid);
