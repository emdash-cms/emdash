-- EmDash plugin registry aggregator: initial schema.
--
-- Lands every table that the v1 read API + ingest pipeline + label hydration
-- + mirror tracking needs, at once on purpose: features that read these
-- tables don't need to add new ones, so this is the only DDL we expect to
-- ship while NSIDs remain experimental.

------------------------------------------------------------------------------
-- Records: package profiles + releases
------------------------------------------------------------------------------

CREATE TABLE packages (
	did TEXT NOT NULL,
	slug TEXT NOT NULL,
	type TEXT NOT NULL,                         -- 'emdash-plugin'
	name TEXT,
	description TEXT,
	license TEXT NOT NULL,
	authors TEXT NOT NULL,                      -- JSON array
	security TEXT NOT NULL,                     -- JSON array
	keywords TEXT,                              -- JSON array
	sections TEXT,                              -- JSON map
	last_updated TEXT,
	-- Denormalised from latest release for query convenience. Updated on every
	-- new release insert; readers never compute "latest" by sorting.
	latest_version TEXT,
	capabilities TEXT,                          -- JSON array
	-- Raw signed record bytes for verification + envelope passthrough. Clients
	-- re-verify the MST signature against the publisher's DID document at
	-- install time.
	record_blob BLOB NOT NULL,
	signature_metadata TEXT,                    -- JSON: head CID, signing key id
	verified_at TEXT NOT NULL,
	PRIMARY KEY (did, slug)
);

CREATE TABLE releases (
	did TEXT NOT NULL,
	package TEXT NOT NULL,                      -- matches the parent profile's rkey/slug (record.package field)
	version TEXT NOT NULL,                      -- canonical (un-percent-encoded) semver from record.version
	rkey TEXT NOT NULL,                         -- exact rkey of the form `<package>:<encoded-version>`
	-- Pre-computed semver-precedence-ordered string for ORDER BY. Application
	-- code writes this; SQLite cannot compute semver order natively. Format
	-- packs zero-padded major.minor.patch with prerelease tags compared per
	-- semver precedence rules.
	version_sort TEXT NOT NULL,
	artifacts TEXT NOT NULL,                    -- JSON
	requires TEXT,                              -- JSON
	suggests TEXT,                              -- JSON
	-- com.emdashcms.experimental.package.releaseExtension contents:
	-- { declaredAccess }. The capabilities-shaped projection lives in
	-- packages.capabilities for query convenience.
	emdash_extension TEXT NOT NULL,
	repo_url TEXT,
	cts TEXT NOT NULL,                          -- creation timestamp from the record
	record_blob BLOB NOT NULL,
	signature_metadata TEXT,
	verified_at TEXT NOT NULL,
	tombstoned_at TEXT,                         -- soft delete (publisher deleted record)
	PRIMARY KEY (did, package, version),
	FOREIGN KEY (did, package) REFERENCES packages(did, slug)
);

CREATE INDEX idx_releases_latest ON releases(did, package, version_sort DESC) WHERE tombstoned_at IS NULL;
CREATE INDEX idx_releases_cts ON releases(cts);

-- Audit trail for rejected duplicate-version attempts. FAIR PR #77 makes
-- versions immutable: a second record at the same (did, package, version) is
-- rejected at the SQL layer and logged here for forensics.
CREATE TABLE release_duplicate_attempts (
	did TEXT NOT NULL,
	package TEXT NOT NULL,
	version TEXT NOT NULL,
	rejected_at TEXT NOT NULL,
	reason TEXT NOT NULL,
	attempted_record_blob BLOB NOT NULL
);

CREATE INDEX idx_release_duplicates ON release_duplicate_attempts(did, package, version);

------------------------------------------------------------------------------
-- Mirror tracking (populated when the artifact mirror lands)
------------------------------------------------------------------------------

CREATE TABLE mirrored_artifacts (
	did TEXT NOT NULL,
	slug TEXT NOT NULL,
	version TEXT NOT NULL,
	artifact_id TEXT NOT NULL,                  -- 'package', 'icon', etc.
	r2_key TEXT NOT NULL,
	bytes INTEGER NOT NULL,
	content_type TEXT NOT NULL,
	mirrored_at TEXT NOT NULL,
	PRIMARY KEY (did, slug, version, artifact_id)
);

------------------------------------------------------------------------------
-- Labels (populated when the labeller integration lands)
------------------------------------------------------------------------------

-- Append-only label history. Every label received is written here, including
-- negations. Current state is derived from latest cts per (src, uri, val) and
-- projected into label_state below for hot-path lookups.
CREATE TABLE labels (
	src TEXT NOT NULL,                          -- labeller DID
	uri TEXT NOT NULL,                          -- AT URI of subject
	cid TEXT,                                   -- optional version-specific CID
	val TEXT NOT NULL,                          -- e.g. 'security:yanked', '!takedown'
	neg INTEGER NOT NULL DEFAULT 0,
	cts TEXT NOT NULL,
	exp TEXT,                                   -- optional expiry (RFC 3339)
	sig BLOB NOT NULL,                          -- raw signature for client re-verification
	ver INTEGER NOT NULL DEFAULT 1,
	trusted INTEGER NOT NULL DEFAULT 0,
	received_at TEXT NOT NULL,
	PRIMARY KEY (src, uri, val, cts)
);

CREATE INDEX idx_labels_subject ON labels(uri);
CREATE INDEX idx_labels_latest ON labels(src, uri, val, cts DESC);

-- Latest-state projection: one row per (src, uri, val) holding the most recent
-- cts seen, including the neg flag and exp timestamp. Updated on every label
-- write within the same transaction. Query-time filters apply
-- `neg = 0 AND (exp IS NULL OR exp > now())` to determine whether a label is
-- currently in force.
--
-- Why retain rows for negated/expired labels rather than deleting them: an
-- out-of-order delivery (a positive label arriving after its negation) could
-- otherwise reinsert a row we'd already retracted. Keeping the row with its
-- `cts` lets the upsert reject the older positive.
CREATE TABLE label_state (
	src TEXT NOT NULL,
	uri TEXT NOT NULL,
	val TEXT NOT NULL,
	cid TEXT,
	neg INTEGER NOT NULL DEFAULT 0,
	cts TEXT NOT NULL,
	exp TEXT,
	trusted INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (src, uri, val)
);

-- Hot path for hard filters (yanked, takedown, etc.) from trusted issuers.
-- Partial index keeps the index small by storing only currently-active rows.
CREATE INDEX idx_label_state_enforce ON label_state(uri, val, trusted)
	WHERE neg = 0 AND trusted = 1;

-- Trusted/known labellers (operator config, edited via deployment).
CREATE TABLE labellers (
	did TEXT PRIMARY KEY,
	endpoint TEXT NOT NULL,                     -- subscribeLabels URL
	signing_key TEXT NOT NULL,                  -- cached #atproto_label key
	signing_key_id TEXT NOT NULL,
	trusted INTEGER NOT NULL DEFAULT 0,
	added_at TEXT NOT NULL,
	last_resolved_at TEXT NOT NULL,
	notes TEXT
);

------------------------------------------------------------------------------
-- Search: FTS5 over packages
------------------------------------------------------------------------------

CREATE VIRTUAL TABLE packages_fts USING fts5(
	name,
	description,
	keywords,
	authors,
	sections,
	content='packages',
	content_rowid='rowid',
	tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER packages_ai AFTER INSERT ON packages BEGIN
	INSERT INTO packages_fts(rowid, name, description, keywords, authors, sections)
	VALUES (new.rowid, new.name, new.description, new.keywords, new.authors, new.sections);
END;

CREATE TRIGGER packages_au AFTER UPDATE ON packages BEGIN
	INSERT INTO packages_fts(packages_fts, rowid, name, description, keywords, authors, sections)
	VALUES ('delete', old.rowid, old.name, old.description, old.keywords, old.authors, old.sections);
	INSERT INTO packages_fts(rowid, name, description, keywords, authors, sections)
	VALUES (new.rowid, new.name, new.description, new.keywords, new.authors, new.sections);
END;

CREATE TRIGGER packages_ad AFTER DELETE ON packages BEGIN
	INSERT INTO packages_fts(packages_fts, rowid, name, description, keywords, authors, sections)
	VALUES ('delete', old.rowid, old.name, old.description, old.keywords, old.authors, old.sections);
END;

------------------------------------------------------------------------------
-- Ingest cursor state
------------------------------------------------------------------------------

-- Cursor state for ingest sources (Jetstream microsecond timestamp,
-- subscribeLabels seq cursors per labeller, etc.).
CREATE TABLE ingest_state (
	source TEXT PRIMARY KEY,                    -- 'jetstream', 'labeller:did:web:labels.example.com', etc.
	cursor TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

-- Known publisher DIDs we've seen via Jetstream or Constellation. Reconciliation
-- iterates this table; cold-start backfill seeds it from Constellation.
CREATE TABLE known_publishers (
	did TEXT PRIMARY KEY,
	pds TEXT,                                   -- cached PDS endpoint from DID document
	pds_resolved_at TEXT,
	first_seen_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL
);
