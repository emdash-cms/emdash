-- Store the verified EmDash package-profile extension so public discovery can
-- fail closed for records that the installer would reject.

ALTER TABLE packages ADD COLUMN emdash_extension TEXT;
ALTER TABLE package_profile_revisions ADD COLUMN emdash_extension TEXT;
ALTER TABLE public_packages ADD COLUMN emdash_extension TEXT;

-- Existing projections predate profile-extension validation. Drop them so a
-- rebuild cannot keep advertising records whose installability is unknown.
DELETE FROM public_releases;
DELETE FROM public_packages;
