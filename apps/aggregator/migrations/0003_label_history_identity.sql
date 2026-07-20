-- Collision-safe label history identity + integer-comparable timestamps.
--
-- `labels`/`label_state` are empty in every deployment (no writer exists yet;
-- production preflight confirmed zero rows), so this drops and recreates both
-- rather than migrating data. Primary key becomes the SHA-256 digest of the
-- canonical signed-label bytes (`encodeSignedLabel`), so exact redelivery is a
-- silent no-op; `UNIQUE (src, source_sequence, frame_index)` catches a
-- different label landing at coordinates the ingestor already used. `cts`/`exp`
-- gain epoch-millisecond columns because RFC 3339 strings compare incorrectly
-- across timezone offsets in SQL.
-- Guard: refuse to run against a deployment that has label rows. The
-- reference deployment was preflight-confirmed empty, but a self-hosted
-- aggregator may not be. The CHECK is unsatisfiable, so the INSERTs only
-- succeed when their SELECTs return no rows.
CREATE TABLE _label_migration_guard (never INTEGER CHECK (never IS NULL AND never IS NOT NULL));
INSERT INTO _label_migration_guard SELECT 1 FROM labels LIMIT 1;
INSERT INTO _label_migration_guard SELECT 1 FROM label_state LIMIT 1;
DROP TABLE _label_migration_guard;

DROP TABLE labels;
DROP TABLE label_state;

-- Append-only label history. Every label received is written here, including
-- negations. Current state is derived from latest cts per (src, uri, val) and
-- projected into label_state below for hot-path lookups.
CREATE TABLE labels (
	digest TEXT PRIMARY KEY,                    -- SHA-256 hex of encodeSignedLabel(label)
	src TEXT NOT NULL,                          -- labeler DID
	uri TEXT NOT NULL,                          -- AT URI of subject
	cid TEXT,                                   -- optional version-specific CID
	val TEXT NOT NULL,                          -- e.g. 'security-yanked', '!takedown'
	neg INTEGER NOT NULL DEFAULT 0,
	cts TEXT NOT NULL,
	cts_epoch_ms INTEGER NOT NULL,
	exp TEXT,                                   -- optional expiry (RFC 3339)
	exp_epoch_ms INTEGER,
	sig BLOB NOT NULL,                          -- raw signature for client re-verification
	ver INTEGER NOT NULL DEFAULT 1,
	source_sequence INTEGER NOT NULL,           -- subscribeLabels frame seq
	frame_index INTEGER NOT NULL,               -- index of this label within the frame's labels array
	trusted INTEGER NOT NULL DEFAULT 0,
	received_at TEXT NOT NULL,
	UNIQUE (src, source_sequence, frame_index)
);

CREATE INDEX idx_labels_subject ON labels(uri);
CREATE INDEX idx_labels_latest ON labels(src, uri, val, cts_epoch_ms DESC);

-- Latest-state projection: one row per (src, uri, val) holding the most recent
-- cts seen, including the neg flag and exp timestamp. Updated in the same
-- batch as the labels insert above. Query-time filters apply
-- `neg = 0 AND (exp_epoch_ms IS NULL OR exp_epoch_ms > now())` to determine
-- whether a label is currently in force.
--
-- Why retain rows for negated/expired labels rather than deleting them: an
-- out-of-order delivery (a positive label arriving after its negation) could
-- otherwise reinsert a row we'd already retracted. Keeping the row with its
-- `cts_epoch_ms` lets the upsert reject the older positive.
CREATE TABLE label_state (
	src TEXT NOT NULL,
	uri TEXT NOT NULL,
	val TEXT NOT NULL,
	cid TEXT,
	neg INTEGER NOT NULL DEFAULT 0,
	cts TEXT NOT NULL,
	cts_epoch_ms INTEGER NOT NULL,
	exp TEXT,
	exp_epoch_ms INTEGER,
	digest TEXT NOT NULL,
	source_sequence INTEGER NOT NULL,
	frame_index INTEGER NOT NULL,
	trusted INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (src, uri, val)
);

-- Hot path for hard filters (yanked, takedown, etc.) from trusted issuers.
-- Partial index keeps the index small by storing only currently-active rows.
CREATE INDEX idx_label_state_enforce ON label_state(uri, val, trusted)
	WHERE neg = 0 AND trusted = 1;
