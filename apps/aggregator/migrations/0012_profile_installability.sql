-- Preserve installation-verification metadata beside every package-profile
-- snapshot. Profiles without this optional extension remain installable;
-- provenance is required only when their signed policy opts into it.

ALTER TABLE packages ADD COLUMN emdash_extension TEXT;
ALTER TABLE packages ADD COLUMN installability_status TEXT NOT NULL DEFAULT 'valid'
	CHECK (installability_status IN ('pending', 'valid', 'invalid'));
ALTER TABLE packages ADD COLUMN installability_error TEXT;

ALTER TABLE package_profile_revisions ADD COLUMN emdash_extension TEXT;
ALTER TABLE package_profile_revisions ADD COLUMN installability_status TEXT NOT NULL DEFAULT 'valid'
	CHECK (installability_status IN ('pending', 'valid', 'invalid'));
ALTER TABLE package_profile_revisions ADD COLUMN installability_error TEXT;

ALTER TABLE public_packages ADD COLUMN emdash_extension TEXT;
ALTER TABLE public_packages ADD COLUMN installability_status TEXT NOT NULL DEFAULT 'valid'
	CHECK (installability_status IN ('pending', 'valid', 'invalid'));
ALTER TABLE public_packages ADD COLUMN installability_error TEXT;
