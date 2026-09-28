-- Retain package-level release history evidence separately from the current
-- profile/release projections. Existing rows came from an initial backfill or
-- an earlier deployment whose cursor continuity cannot be proven, so they
-- start incomplete and remain subject to the configured release-age holdback.
CREATE TABLE IF NOT EXISTS package_release_history (
	did TEXT NOT NULL,
	package TEXT NOT NULL,
	release_history_complete INTEGER NOT NULL CHECK (release_history_complete IN (0, 1)),
	first_observed_at TEXT NOT NULL,
	first_observed_source TEXT NOT NULL CHECK (
		first_observed_source IN ('jetstream', 'backfill', 'unknown')
	),
	PRIMARY KEY (did, package)
);

INSERT OR IGNORE INTO package_release_history (
	did,
	package,
	release_history_complete,
	first_observed_at,
	first_observed_source
)
SELECT
	did,
	slug,
	0,
	COALESCE(indexed_at, verified_at),
	'unknown'
FROM packages;
