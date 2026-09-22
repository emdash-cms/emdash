CREATE TRIGGER IF NOT EXISTS listing_projection_withdrawal_authorization_bi
	BEFORE INSERT ON listing_projection_redaction_events
	WHEN NEW.val IN ('security:yanked', 'security-yanked')
		AND NOT EXISTS (
			SELECT 1 FROM labellers source
			WHERE source.did = NEW.src
				AND source.active = 1
				AND source.trusted = 1
				AND source.redaction = 1
		) BEGIN
	SELECT RAISE(IGNORE);
END;

CREATE TRIGGER IF NOT EXISTS label_state_projection_restrictive_collision_au
	AFTER UPDATE ON label_state
	WHEN OLD.collision = 0
		AND NEW.collision = 1
		AND NEW.trusted = 1
		AND NEW.val IN ('listing-blocked', '!takedown', 'security:yanked', 'security-yanked') BEGIN
	INSERT INTO listing_projection_redaction_events (src, uri, cid, val)
	SELECT candidate.src, candidate.uri, candidate.cid, candidate.val
	FROM listing_labels candidate
	WHERE candidate.src = NEW.src
		AND candidate.uri = NEW.uri
		AND candidate.val = NEW.val
		AND candidate.cts_epoch = NEW.cts_epoch
		AND candidate.cts_fraction = NEW.cts_fraction
		AND candidate.neg = 0
		AND (candidate.exp IS NULL OR candidate.exp_epoch > unixepoch('now'));
END;

CREATE TRIGGER IF NOT EXISTS listing_labels_projection_restrictive_collision_ai
	AFTER INSERT ON listing_labels
	WHEN NEW.neg = 0
		AND (NEW.exp IS NULL OR NEW.exp_epoch > unixepoch('now'))
		AND NEW.val IN ('listing-blocked', '!takedown', 'security:yanked', 'security-yanked')
		AND EXISTS (
			SELECT 1 FROM label_state state
			WHERE state.src = NEW.src
				AND state.uri = NEW.uri
				AND state.val = NEW.val
				AND state.cts_epoch = NEW.cts_epoch
				AND state.cts_fraction = NEW.cts_fraction
				AND state.collision = 1
				AND state.trusted = 1
		) BEGIN
	INSERT INTO listing_projection_redaction_events (src, uri, cid, val)
	VALUES (NEW.src, NEW.uri, NEW.cid, NEW.val);
END;

CREATE TRIGGER IF NOT EXISTS label_state_projection_restrictive_activation_au
	AFTER UPDATE OF trusted ON label_state
	WHEN OLD.trusted <> 1
		AND NEW.trusted = 1
		AND NEW.collision = 1
		AND NEW.val IN ('listing-blocked', '!takedown', 'security:yanked', 'security-yanked') BEGIN
	INSERT INTO listing_projection_redaction_events (src, uri, cid, val)
	SELECT candidate.src, candidate.uri, candidate.cid, candidate.val
	FROM listing_labels candidate
	WHERE candidate.src = NEW.src
		AND candidate.uri = NEW.uri
		AND candidate.val = NEW.val
		AND candidate.cts_epoch = NEW.cts_epoch
		AND candidate.cts_fraction = NEW.cts_fraction
		AND candidate.neg = 0
		AND (candidate.exp IS NULL OR candidate.exp_epoch > unixepoch('now'));
END;

INSERT INTO listing_projection_redaction_events (src, uri, cid, val)
SELECT candidate.src, candidate.uri, candidate.cid, candidate.val
FROM label_state state
JOIN listing_labels candidate
	ON candidate.src = state.src
	AND candidate.uri = state.uri
	AND candidate.val = state.val
	AND candidate.cts_epoch = state.cts_epoch
	AND candidate.cts_fraction = state.cts_fraction
WHERE state.collision = 1
	AND state.trusted = 1
	AND state.val IN ('listing-blocked', '!takedown', 'security:yanked', 'security-yanked')
	AND candidate.neg = 0
	AND (candidate.exp IS NULL OR candidate.exp_epoch > unixepoch('now'));
