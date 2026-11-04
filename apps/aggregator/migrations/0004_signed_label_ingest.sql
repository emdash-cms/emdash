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
ALTER TABLE labellers ADD COLUMN health_last_success_at TEXT;
ALTER TABLE labellers ADD COLUMN health_last_success_epoch INTEGER;
ALTER TABLE labellers ADD COLUMN health_failure_started_at TEXT;
ALTER TABLE labellers ADD COLUMN health_failure_started_epoch INTEGER;
ALTER TABLE labellers ADD COLUMN health_failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE labellers ADD COLUMN replay_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE labellers ADD COLUMN replay_generation INTEGER NOT NULL DEFAULT 0;

UPDATE labellers SET
	health_last_success_at = last_resolved_at,
	health_last_success_epoch = unixepoch(last_resolved_at) * 1000
WHERE active = 1
	AND trusted = 1
	AND unixepoch(last_resolved_at) IS NOT NULL;

CREATE INDEX idx_labellers_required_health
	ON labellers(active, required_positive, accepted_state, redaction, trusted,
		health_last_success_epoch, health_failure_started_epoch);

CREATE TABLE listing_replay_restrictions (
	src TEXT NOT NULL,
	uri TEXT NOT NULL,
	val TEXT NOT NULL,
	cid TEXT,
	cid_key TEXT NOT NULL,
	exp_epoch INTEGER,
	PRIMARY KEY (src, uri, val, cid_key)
);

CREATE INDEX idx_listing_replay_restrictions_subject
	ON listing_replay_restrictions(uri, val, src);

CREATE TRIGGER labellers_replay_restrictions_au
	AFTER UPDATE ON labellers
	WHEN NEW.active = 1
		AND NEW.replay_pending = 1
		AND ((OLD.trusted = 1 AND NEW.trusted = 0) OR (OLD.active = 0 AND NEW.active = 1)) BEGIN
	DELETE FROM listing_replay_restrictions WHERE src = NEW.did;
	INSERT OR IGNORE INTO listing_replay_restrictions
		(src, uri, val, cid, cid_key, exp_epoch)
	SELECT state.src, state.uri, state.val, state.cid, COALESCE(state.cid, ''), expiry.exp_epoch
	FROM label_state state
	LEFT JOIN listing_label_state_expiry expiry
		ON expiry.src = state.src AND expiry.uri = state.uri AND expiry.val = state.val
		AND expiry.exp = state.exp
	WHERE state.src = NEW.did
		AND state.neg = 0
		AND state.val IN ('listing-blocked', '!takedown', 'security:yanked', 'security-yanked')
		AND (state.exp IS NULL OR expiry.exp_epoch > unixepoch('now'));
	INSERT OR IGNORE INTO listing_replay_restrictions
		(src, uri, val, cid, cid_key, exp_epoch)
	SELECT candidate.src, candidate.uri, candidate.val, candidate.cid,
		COALESCE(candidate.cid, ''), candidate.exp_epoch
	FROM listing_labels candidate
	JOIN label_state state
		ON state.src = candidate.src AND state.uri = candidate.uri AND state.val = candidate.val
		AND state.cts_epoch = candidate.cts_epoch
		AND state.cts_fraction = candidate.cts_fraction
	WHERE candidate.src = NEW.did
		AND candidate.neg = 0
		AND candidate.val IN ('listing-blocked', '!takedown', 'security:yanked', 'security-yanked')
		AND (candidate.exp IS NULL OR candidate.exp_epoch > unixepoch('now'));
END;

CREATE TRIGGER listing_labels_replay_restrictions_ai
	AFTER INSERT ON listing_labels
	WHEN NEW.neg = 0
		AND NEW.val IN ('listing-blocked', '!takedown', 'security:yanked', 'security-yanked')
		AND (NEW.exp IS NULL OR NEW.exp_epoch > unixepoch('now'))
		AND EXISTS (
			SELECT 1 FROM labellers source
			WHERE source.did = NEW.src AND source.active = 1 AND source.replay_pending = 1
		) BEGIN
	INSERT INTO listing_replay_restrictions (src, uri, val, cid, cid_key, exp_epoch)
	VALUES (NEW.src, NEW.uri, NEW.val, NEW.cid, COALESCE(NEW.cid, ''), NEW.exp_epoch)
	ON CONFLICT(src, uri, val, cid_key) DO UPDATE SET exp_epoch = excluded.exp_epoch;
END;

CREATE TRIGGER label_state_replay_restrictions_ai
	AFTER INSERT ON label_state
	WHEN NEW.neg = 0
		AND NEW.val IN ('listing-blocked', '!takedown', 'security:yanked', 'security-yanked')
		AND EXISTS (
			SELECT 1 FROM labellers source
			WHERE source.did = NEW.src AND source.active = 1 AND source.replay_pending = 1
		) BEGIN
	INSERT INTO listing_replay_restrictions (src, uri, val, cid, cid_key, exp_epoch)
	SELECT NEW.src, NEW.uri, NEW.val, NEW.cid, COALESCE(NEW.cid, ''), expiry.exp_epoch
	FROM (SELECT 1) singleton
	LEFT JOIN listing_label_state_expiry expiry
		ON expiry.src = NEW.src AND expiry.uri = NEW.uri AND expiry.val = NEW.val
		AND expiry.exp = NEW.exp
	WHERE NEW.exp IS NULL OR expiry.exp_epoch > unixepoch('now')
	ON CONFLICT(src, uri, val, cid_key) DO UPDATE SET exp_epoch = excluded.exp_epoch;
END;

CREATE TRIGGER label_state_replay_restrictions_au
	AFTER UPDATE ON label_state
	WHEN NEW.neg = 0
		AND NEW.val IN ('listing-blocked', '!takedown', 'security:yanked', 'security-yanked')
		AND EXISTS (
			SELECT 1 FROM labellers source
			WHERE source.did = NEW.src AND source.active = 1 AND source.replay_pending = 1
		) BEGIN
	INSERT INTO listing_replay_restrictions (src, uri, val, cid, cid_key, exp_epoch)
	SELECT NEW.src, NEW.uri, NEW.val, NEW.cid, COALESCE(NEW.cid, ''), expiry.exp_epoch
	FROM (SELECT 1) singleton
	LEFT JOIN listing_label_state_expiry expiry
		ON expiry.src = NEW.src AND expiry.uri = NEW.uri AND expiry.val = NEW.val
		AND expiry.exp = NEW.exp
	WHERE NEW.exp IS NULL OR expiry.exp_epoch > unixepoch('now')
	ON CONFLICT(src, uri, val, cid_key) DO UPDATE SET exp_epoch = excluded.exp_epoch;
END;

CREATE TRIGGER labellers_replay_restrictions_clear_au
	AFTER UPDATE ON labellers
	WHEN (OLD.replay_pending = 1 AND NEW.replay_pending = 0) OR (OLD.active = 1 AND NEW.active = 0)
	BEGIN
	DELETE FROM listing_replay_restrictions WHERE src = NEW.did;
END;

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
