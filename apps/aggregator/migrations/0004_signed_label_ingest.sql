-- Signed label ingestion state. The original `labels` table remains readable
-- for compatibility; all verified writes use the collision-safe history below.

CREATE TABLE IF NOT EXISTS listing_labels (
	digest TEXT PRIMARY KEY,
	state_digest TEXT NOT NULL,
	src TEXT NOT NULL,
	uri TEXT NOT NULL,
	cid TEXT,
	val TEXT NOT NULL,
	neg INTEGER NOT NULL CHECK (neg IN (0, 1)),
	cts TEXT NOT NULL,
	cts_epoch INTEGER NOT NULL,
	cts_fraction TEXT NOT NULL,
	exp TEXT,
	exp_epoch INTEGER,
	sig BLOB NOT NULL,
	ver INTEGER NOT NULL,
	received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_listing_labels_subject
	ON listing_labels(src, uri, val, cts_epoch DESC, cts_fraction DESC);

CREATE TABLE IF NOT EXISTS listing_label_stream_coordinates (
	src TEXT NOT NULL,
	source_sequence INTEGER NOT NULL,
	frame_index INTEGER NOT NULL,
	digest TEXT NOT NULL,
	PRIMARY KEY (src, source_sequence, frame_index),
	FOREIGN KEY (digest) REFERENCES listing_labels(digest)
);

CREATE TRIGGER IF NOT EXISTS listing_label_stream_coordinate_collision
	BEFORE UPDATE OF digest ON listing_label_stream_coordinates
	WHEN OLD.digest <> NEW.digest BEGIN
	SELECT RAISE(ABORT, 'listing label stream coordinate collision');
END;

ALTER TABLE label_state ADD COLUMN cts_epoch INTEGER;
ALTER TABLE label_state ADD COLUMN cts_fraction TEXT NOT NULL DEFAULT '';
ALTER TABLE label_state ADD COLUMN digest TEXT;
ALTER TABLE label_state ADD COLUMN source_sequence INTEGER;
ALTER TABLE label_state ADD COLUMN frame_index INTEGER;
ALTER TABLE label_state ADD COLUMN collision INTEGER NOT NULL DEFAULT 1;

ALTER TABLE labellers ADD COLUMN active INTEGER NOT NULL DEFAULT 0;
ALTER TABLE labellers ADD COLUMN required_positive INTEGER NOT NULL DEFAULT 0;
ALTER TABLE labellers ADD COLUMN accepted_state INTEGER NOT NULL DEFAULT 0;
ALTER TABLE labellers ADD COLUMN redaction INTEGER NOT NULL DEFAULT 0;
ALTER TABLE labellers ADD COLUMN policy_version TEXT NOT NULL DEFAULT '';
ALTER TABLE labellers ADD COLUMN stop_acknowledged INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS labeler_signing_keys (
	did TEXT NOT NULL,
	signing_key TEXT NOT NULL,
	first_seen_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	PRIMARY KEY (did, signing_key)
);

CREATE TABLE IF NOT EXISTS listing_projection_work (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	dirty_epoch INTEGER NOT NULL DEFAULT 0,
	scheduled_epoch INTEGER NOT NULL DEFAULT 0,
	acknowledged_epoch INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO listing_projection_work (
	id, dirty_epoch, scheduled_epoch, acknowledged_epoch
) VALUES (1, 0, 0, 0);

CREATE TRIGGER IF NOT EXISTS listing_projection_control_mark_dirty
	AFTER UPDATE OF source_epoch ON listing_projection_control
	WHEN NEW.source_epoch <> OLD.source_epoch BEGIN
	UPDATE listing_projection_work SET dirty_epoch = NEW.source_epoch WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS listing_labels_require_active_source
	BEFORE INSERT ON listing_labels
	WHEN NOT EXISTS (
		SELECT 1 FROM labellers
		WHERE did = NEW.src AND active = 1
	) BEGIN
	SELECT RAISE(ABORT, 'listing label source is inactive');
END;

CREATE INDEX IF NOT EXISTS idx_labellers_active ON labellers(active, did);

-- A same-instant disagreement for one (source, URI, value) is deliberately
-- inactive. If it invalidates a pass, remove that projection immediately.
CREATE TRIGGER IF NOT EXISTS label_state_projection_collision_au
	AFTER UPDATE ON label_state
	WHEN OLD.collision = 0
		AND NEW.collision = 1
		AND OLD.trusted = 1
		AND OLD.val = 'listing-passed'
		AND OLD.neg = 0
		AND OLD.cid IS NOT NULL BEGIN
	INSERT INTO listing_projection_redaction_events (src, uri, cid, val)
	VALUES (OLD.src, OLD.uri, OLD.cid, 'listing-passed-lost');
END;
