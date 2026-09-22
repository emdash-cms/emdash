-- Preserve install-verification state beside every package-profile snapshot.
-- Historical rows start pending until the authenticated reconciliation pass
-- re-fetches their current records from the publisher PDS.

ALTER TABLE packages ADD COLUMN emdash_extension TEXT;
ALTER TABLE packages ADD COLUMN installability_status TEXT NOT NULL DEFAULT 'pending'
	CHECK (installability_status IN ('pending', 'valid', 'invalid'));
ALTER TABLE packages ADD COLUMN installability_error TEXT;

ALTER TABLE package_profile_revisions ADD COLUMN emdash_extension TEXT;
ALTER TABLE package_profile_revisions ADD COLUMN installability_status TEXT NOT NULL DEFAULT 'pending'
	CHECK (installability_status IN ('pending', 'valid', 'invalid'));
ALTER TABLE package_profile_revisions ADD COLUMN installability_error TEXT;

ALTER TABLE public_packages ADD COLUMN emdash_extension TEXT;
ALTER TABLE public_packages ADD COLUMN installability_status TEXT NOT NULL DEFAULT 'pending'
	CHECK (installability_status IN ('pending', 'valid', 'invalid'));
ALTER TABLE public_packages ADD COLUMN installability_error TEXT;

CREATE INDEX IF NOT EXISTS idx_package_profile_revisions_installability
	ON package_profile_revisions(installability_status, did, slug)
	WHERE installability_status = 'pending';

CREATE TABLE IF NOT EXISTS profile_installability_reconciliation (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete')),
	completed_at TEXT
);

INSERT OR IGNORE INTO profile_installability_reconciliation (id, status, completed_at)
	VALUES (1, 'pending', NULL);
