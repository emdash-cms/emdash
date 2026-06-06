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
	-- ON DELETE CASCADE because Jetstream events for a publisher can arrive
	-- in arbitrary order under network reorder. A publisher who deletes their
	-- profile (and all releases) emits the events in author-order, but the
	-- profile-delete might land at the consumer before the release-deletes.
	-- Without cascade, the consumer would have to either skip the profile
	-- delete (leaving stale rows) or sequence retries, neither of which is
	-- worth the complexity. Releases are version-immutable from a publishing
	-- perspective, but a publisher is still entitled to remove their entire
	-- package; cascade mirrors that intent.
	FOREIGN KEY (did, package) REFERENCES packages(did, slug) ON DELETE CASCADE
);

CREATE INDEX idx_releases_latest ON releases(did, package, version_sort DESC) WHERE tombstoned_at IS NULL;
CREATE INDEX idx_releases_cts ON releases(cts);

-- Audit trail for rejected duplicate-version attempts. FAIR PR #77 makes
-- versions immutable: a second record at the same (did, package, version) is
-- rejected at the SQL layer and logged here for forensics.
--
-- The UNIQUE constraint dedupes attempts by content (CID), not by raw bytes.
-- CAR bytes include the publisher's commit + MST proof which churns whenever
-- the publisher writes any other record in the same repo, so byte-equality
-- would misclassify benign retries as new attempts and bloat the table.
-- The CID is content-addressed and stable for an unchanged record.
--
-- The consumer's INSERT uses `ON CONFLICT … DO UPDATE SET rejected_at,
-- attempted_record_blob = excluded.{rejected_at, attempted_record_blob}` so
-- the row tracks the latest attempt timestamp + the latest envelope bytes
-- (newer proofs supersede older ones in the forensics column).
CREATE TABLE release_duplicate_attempts (
	did TEXT NOT NULL,
	package TEXT NOT NULL,
	version TEXT NOT NULL,
	-- CID of the verified record (stable for content; changes only when the
	-- record itself changes). Used as the dedup key.
	attempted_cid TEXT NOT NULL,
	rejected_at TEXT NOT NULL,
	reason TEXT NOT NULL,
	-- Raw CAR bytes from the most recent attempt. Kept for forensics so
	-- operators can inspect what was actually attempted even if the
	-- publisher has since deleted the offending record.
	attempted_record_blob BLOB NOT NULL,
	UNIQUE (did, package, version, attempted_cid)
);

-- The UNIQUE constraint creates an implicit index on
-- (did, package, version, attempted_record_blob); a separate index on the
-- (did, package, version) prefix is redundant for both lookups (the implicit
-- index handles prefix seeks) and inserts (one fewer index to maintain).

------------------------------------------------------------------------------
-- Publishers: identity-level publisher profiles + verification claims
------------------------------------------------------------------------------

-- One row per publisher DID (rkey is always literal `self`). Optional: a DID
-- may publish packages without ever publishing a publisher.profile, in which
-- case the row is absent and clients fall back to the handle. This table is
-- the canonical source for "who is publishing these packages?" — distinct from
-- `packages.authors`, which is per-package and remains authoritative for that
-- package.
CREATE TABLE publishers (
	did TEXT PRIMARY KEY,
	display_name TEXT NOT NULL,                 -- bound by verification records — see publisher_verifications
	description TEXT,
	url TEXT,
	contact TEXT,                               -- JSON array of { kind, url?, email? }
	updated_at TEXT,
	record_blob BLOB NOT NULL,
	signature_metadata TEXT,                    -- JSON: head CID, signing key id
	verified_at TEXT NOT NULL
);

-- Verification claims: issuer DID vouches for subject DID as a trusted
-- publisher. The rkey is a TID, so an issuer can issue multiple claims (e.g.
-- delegated + official) and we store each as its own row. Validity is bound to
-- the subject's handle + publisher.profile.displayName at issuance time:
-- clients re-resolve those at read time and treat the claim as not in force if
-- either has changed. Ingest stores the facts; the validity check is a
-- query-time concern.
CREATE TABLE publisher_verifications (
	issuer_did TEXT NOT NULL,                   -- DID of the repo that wrote the record
	rkey TEXT NOT NULL,                         -- TID
	subject_did TEXT NOT NULL,
	subject_handle TEXT NOT NULL,               -- bound at issuance; query-time validity check compares against current
	subject_display_name TEXT NOT NULL,         -- bound at issuance; query-time validity check compares against current
	created_at TEXT NOT NULL,
	expires_at TEXT,
	record_blob BLOB NOT NULL,
	signature_metadata TEXT,
	verified_at TEXT NOT NULL,
	tombstoned_at TEXT,
	PRIMARY KEY (issuer_did, rkey)
);

-- Hot path: "show me all unexpired, non-tombstoned verifications for subject X".
-- Partial index keeps the index small by excluding tombstoned rows.
CREATE INDEX idx_publisher_verifications_subject ON publisher_verifications(subject_did)
	WHERE tombstoned_at IS NULL;

-- For periodic expiry sweeps.
CREATE INDEX idx_publisher_verifications_expires ON publisher_verifications(expires_at)
	WHERE expires_at IS NOT NULL AND tombstoned_at IS NULL;

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
--
-- Doubles as the DID-document resolution cache: `pds`, `signing_key`,
-- `signing_key_id` are populated by the records consumer on first verification
-- and refreshed when `pds_resolved_at` is older than the consumer's TTL
-- (currently 24h, applied at query time as
-- `pds_resolved_at > datetime('now', '-1 day')`). Backfill may insert a row
-- with these fields null; the consumer's first event for that DID forces a
-- resolution and UPDATE.
CREATE TABLE known_publishers (
	did TEXT PRIMARY KEY,
	pds TEXT,                                   -- cached PDS endpoint from DID document
	signing_key TEXT,                           -- cached #atproto signing key (multibase)
	signing_key_id TEXT,                        -- e.g. 'did:plc:xxx#atproto'
	pds_resolved_at TEXT,                       -- last successful DID-doc resolution
	first_seen_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL
);

------------------------------------------------------------------------------
-- Verification-failure forensics
------------------------------------------------------------------------------

-- Records that failed PDS-verified ingest (signature, MST proof, AT-URI,
-- lexicon, content-mismatch). Written instead of retrying, because these
-- failures indicate malicious or broken upstream — retrying would just burn
-- PDS round trips. Operators query this table to investigate suspected attacks
-- or upstream regressions; it is NOT used as a retry queue.
--
-- Distinct from the configured Cloudflare DLQ (`emdash-aggregator-records-dlq`,
-- see wrangler.jsonc), which receives messages after `max_retries` exhausted —
-- that is for transient failures (PDS down, profile-not-yet-arrived). Two
-- distinct failure modes, two distinct destinations.
--
-- `payload` holds the unverified record bytes from the Jetstream event so an
-- operator can inspect what was attempted without going back to the source PDS.
CREATE TABLE dead_letters (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	did TEXT NOT NULL,
	collection TEXT NOT NULL,
	rkey TEXT NOT NULL,
	-- Reason code; matches the `DeadLetterReason` union in records-consumer.ts.
	-- Current values: 'RECORD_NOT_FOUND', 'RESPONSE_TOO_LARGE', 'INVALID_PROOF',
	-- 'PDS_HTTP_ERROR', 'LEXICON_VALIDATION_FAILED', 'RKEY_MISMATCH',
	-- 'CONTACT_VALIDATION_FAILED', 'INVALID_VERSION', 'UNKNOWN_COLLECTION',
	-- 'UNEXPECTED_ERROR'.
	reason TEXT NOT NULL,
	-- Free-form context (which field, expected vs got, library error message, etc.).
	detail TEXT,
	-- UTF-8 encoded JSON bytes of `RecordsJob.jetstreamRecord` when present, or a
	-- fallback envelope `{operation, cid}` for delete events that don't carry one.
	-- Stored as BLOB so future formats (CBOR, raw record bytes) can land here
	-- without a schema change; today operators must `CAST(payload AS TEXT)` to
	-- read.
	payload BLOB NOT NULL,
	received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_dead_letters_did ON dead_letters(did);
CREATE INDEX idx_dead_letters_received ON dead_letters(received_at);
