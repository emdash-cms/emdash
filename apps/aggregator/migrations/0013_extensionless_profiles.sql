-- Profiles without the optional repository extension permit releases without
-- provenance. Repair databases that classified those profiles as invalid
-- before this became the default policy.

UPDATE packages
	SET installability_status = 'valid', installability_error = NULL
	WHERE installability_status = 'pending'
		OR installability_error = 'PROFILE_EXTENSION_MISSING';

UPDATE package_profile_revisions
	SET installability_status = 'valid', installability_error = NULL
	WHERE installability_status = 'pending'
		OR installability_error = 'PROFILE_EXTENSION_MISSING';

UPDATE public_packages
	SET installability_status = 'valid', installability_error = NULL
	WHERE installability_status = 'pending'
		OR installability_error = 'PROFILE_EXTENSION_MISSING';

DROP INDEX IF EXISTS idx_package_profile_revisions_installability;
DROP TABLE IF EXISTS profile_installability_reconciliation;
