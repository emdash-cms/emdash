-- Retain immutable verified package-profile revisions and separate staged
-- publisher records from the projection served to ordinary registry clients.
--
-- Every statement is restart-safe. D1 normally applies a migration in one
-- transaction, but `IF NOT EXISTS` plus conflict-free backfills also make a
-- retry safe after an ambiguous response from a partially completed apply.

CREATE TABLE IF NOT EXISTS package_profile_revisions (
	did TEXT NOT NULL,
	slug TEXT NOT NULL,
	cid TEXT NOT NULL,
	type TEXT NOT NULL,
	name TEXT,
	description TEXT,
	license TEXT NOT NULL,
	authors TEXT NOT NULL,
	security TEXT NOT NULL,
	keywords TEXT,
	sections TEXT,
	last_updated TEXT,
	record_blob BLOB NOT NULL,
	signature_metadata TEXT,
	observed_at TEXT NOT NULL,
	last_verified_at TEXT NOT NULL,
	PRIMARY KEY (did, slug, cid)
);

CREATE INDEX IF NOT EXISTS idx_package_profile_revisions_subject
	ON package_profile_revisions(did, slug, observed_at DESC, cid DESC);

CREATE TABLE IF NOT EXISTS package_profile_heads (
	did TEXT NOT NULL,
	slug TEXT NOT NULL,
	current_cid TEXT,
	deleted_at TEXT,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (did, slug)
);

CREATE INDEX IF NOT EXISTS idx_package_profile_heads_current
	ON package_profile_heads(did, slug, current_cid)
	WHERE deleted_at IS NULL AND current_cid IS NOT NULL;

-- Preserve the current mutable row as the first retained revision. Invalid
-- historical signature metadata cannot be assigned an exact CID and is left
-- unpointed/fail-closed for projection mode; all writer-produced rows have a
-- non-empty `cid` string.
INSERT OR IGNORE INTO package_profile_revisions (
	did, slug, cid, type, name, description, license, authors, security,
	keywords, sections, last_updated, record_blob, signature_metadata,
	observed_at, last_verified_at
)
SELECT
	did,
	slug,
	json_extract(signature_metadata, '$.cid'),
	type,
	name,
	description,
	license,
	authors,
	security,
	keywords,
	sections,
	last_updated,
	record_blob,
	signature_metadata,
	COALESCE(indexed_at, verified_at),
	verified_at
FROM packages
WHERE json_type(signature_metadata, '$.cid') = 'text'
	AND length(json_extract(signature_metadata, '$.cid')) > 0;

INSERT OR IGNORE INTO package_profile_heads (
	did, slug, current_cid, deleted_at, updated_at
)
SELECT
	did,
	slug,
	json_extract(signature_metadata, '$.cid'),
	NULL,
	verified_at
FROM packages
WHERE json_type(signature_metadata, '$.cid') = 'text'
	AND length(json_extract(signature_metadata, '$.cid')) > 0;

-- Monotonic input epoch plus rebuild ordering. Every table that can change a
-- visibility decision bumps `source_epoch`; a generation may become active
-- only if the epoch and latest rebuild sequence still match its snapshot.
CREATE TABLE IF NOT EXISTS listing_projection_control (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	source_epoch INTEGER NOT NULL DEFAULT 0,
	latest_rebuild_sequence INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO listing_projection_control (
	id, source_epoch, latest_rebuild_sequence
) VALUES (1, 0, 0);

CREATE TRIGGER IF NOT EXISTS package_profile_revisions_projection_epoch_ai
	AFTER INSERT ON package_profile_revisions BEGIN
	UPDATE listing_projection_control SET source_epoch = source_epoch + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS package_profile_revisions_projection_epoch_au
	AFTER UPDATE ON package_profile_revisions BEGIN
	UPDATE listing_projection_control SET source_epoch = source_epoch + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS package_profile_revisions_projection_epoch_ad
	AFTER DELETE ON package_profile_revisions BEGIN
	UPDATE listing_projection_control SET source_epoch = source_epoch + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS package_profile_heads_projection_epoch_ai
	AFTER INSERT ON package_profile_heads BEGIN
	UPDATE listing_projection_control SET source_epoch = source_epoch + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS package_profile_heads_projection_epoch_au
	AFTER UPDATE ON package_profile_heads BEGIN
	UPDATE listing_projection_control SET source_epoch = source_epoch + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS package_profile_heads_projection_epoch_ad
	AFTER DELETE ON package_profile_heads BEGIN
	UPDATE listing_projection_control SET source_epoch = source_epoch + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS releases_projection_epoch_ai
	AFTER INSERT ON releases BEGIN
	UPDATE listing_projection_control SET source_epoch = source_epoch + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS releases_projection_epoch_au
	AFTER UPDATE ON releases BEGIN
	UPDATE listing_projection_control SET source_epoch = source_epoch + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS releases_projection_epoch_ad
	AFTER DELETE ON releases BEGIN
	UPDATE listing_projection_control SET source_epoch = source_epoch + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS label_state_projection_epoch_ai
	AFTER INSERT ON label_state BEGIN
	UPDATE listing_projection_control SET source_epoch = source_epoch + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS label_state_projection_epoch_au
	AFTER UPDATE ON label_state BEGIN
	UPDATE listing_projection_control SET source_epoch = source_epoch + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS label_state_projection_epoch_ad
	AFTER DELETE ON label_state BEGIN
	UPDATE listing_projection_control SET source_epoch = source_epoch + 1 WHERE id = 1;
END;

-- Expiry epochs are written only by the application after strict RFC 3339
-- validation. Historical strings are deliberately not parsed by SQLite:
-- its date parser accepts invalid calendars and non-RFC separators.
CREATE TABLE IF NOT EXISTS listing_label_state_expiry (
	src TEXT NOT NULL,
	uri TEXT NOT NULL,
	val TEXT NOT NULL,
	exp TEXT,
	exp_epoch INTEGER,
	PRIMARY KEY (src, uri, val)
);

INSERT INTO listing_label_state_expiry (src, uri, val, exp, exp_epoch)
SELECT src, uri, val, exp, NULL
FROM label_state
WHERE 1 = 1
ON CONFLICT(src, uri, val) DO UPDATE SET
	exp = excluded.exp,
	exp_epoch = excluded.exp_epoch;

CREATE TRIGGER IF NOT EXISTS label_state_expiry_ad
	AFTER DELETE ON label_state BEGIN
	DELETE FROM listing_label_state_expiry
	WHERE src = OLD.src AND uri = OLD.uri AND val = OLD.val;
END;

-- Destructive labels cannot wait for a projection rebuild. Both label-state
-- writer paths feed this transient table; its INSERT trigger redacts affected
-- public rows in the same transaction as the winning label-state change.
CREATE TABLE IF NOT EXISTS listing_projection_redaction_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	src TEXT NOT NULL,
	uri TEXT NOT NULL,
	cid TEXT,
	val TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS label_state_projection_redaction_ai
	AFTER INSERT ON label_state
	WHEN NEW.trusted = 1
		AND NEW.neg = 0
		AND (
			NEW.exp IS NULL
			OR EXISTS (
				SELECT 1 FROM listing_label_state_expiry expiry
				WHERE expiry.src = NEW.src AND expiry.uri = NEW.uri AND expiry.val = NEW.val
					AND expiry.exp = NEW.exp
					AND expiry.exp_epoch > unixepoch('now')
			)
		)
		AND NEW.val IN ('listing-blocked', '!takedown', 'security:yanked', 'security-yanked') BEGIN
	INSERT INTO listing_projection_redaction_events (src, uri, cid, val)
	VALUES (NEW.src, NEW.uri, NEW.cid, NEW.val);
END;

CREATE TRIGGER IF NOT EXISTS label_state_projection_redaction_au
	AFTER UPDATE ON label_state
	WHEN NEW.trusted = 1
		AND NEW.neg = 0
		AND (
			NEW.exp IS NULL
			OR EXISTS (
				SELECT 1 FROM listing_label_state_expiry expiry
				WHERE expiry.src = NEW.src AND expiry.uri = NEW.uri AND expiry.val = NEW.val
					AND expiry.exp = NEW.exp
					AND expiry.exp_epoch > unixepoch('now')
			)
		)
		AND NEW.val IN ('listing-blocked', '!takedown', 'security:yanked', 'security-yanked') BEGIN
	INSERT INTO listing_projection_redaction_events (src, uri, cid, val)
	VALUES (NEW.src, NEW.uri, NEW.cid, NEW.val);
END;

CREATE TRIGGER IF NOT EXISTS label_state_projection_pass_loss_au
	AFTER UPDATE ON label_state
	WHEN OLD.trusted = 1
		AND OLD.val = 'listing-passed'
		AND OLD.neg = 0
		AND OLD.cid IS NOT NULL
		AND (
			NEW.trusted <> 1
			OR NEW.neg <> 0
			OR NEW.cid IS NOT OLD.cid
			OR (
				NEW.exp IS NOT NULL
				AND NOT EXISTS (
					SELECT 1 FROM listing_label_state_expiry expiry
					WHERE expiry.src = NEW.src AND expiry.uri = NEW.uri AND expiry.val = NEW.val
						AND expiry.exp = NEW.exp
						AND expiry.exp_epoch > unixepoch('now')
				)
			)
		) BEGIN
	INSERT INTO listing_projection_redaction_events (src, uri, cid, val)
	VALUES (OLD.src, OLD.uri, OLD.cid, 'listing-passed-lost');
END;

CREATE TRIGGER IF NOT EXISTS label_state_projection_pass_loss_ad
	AFTER DELETE ON label_state
	WHEN OLD.trusted = 1
		AND OLD.val = 'listing-passed'
		AND OLD.neg = 0
		AND OLD.cid IS NOT NULL BEGIN
	INSERT INTO listing_projection_redaction_events (src, uri, cid, val)
	VALUES (OLD.src, OLD.uri, OLD.cid, 'listing-passed-lost');
END;

CREATE TRIGGER IF NOT EXISTS label_state_projection_conflict_ai
	AFTER INSERT ON label_state
	WHEN NEW.trusted = 1
		AND NEW.neg = 0
		AND NEW.cid IS NOT NULL
		AND (
			NEW.exp IS NULL
			OR EXISTS (
				SELECT 1 FROM listing_label_state_expiry expiry
				WHERE expiry.src = NEW.src AND expiry.uri = NEW.uri AND expiry.val = NEW.val
					AND expiry.exp = NEW.exp
					AND expiry.exp_epoch > unixepoch('now')
			)
		)
		AND NEW.val IN ('listing-pending', 'listing-review', 'listing-error') BEGIN
	INSERT INTO listing_projection_redaction_events (src, uri, cid, val)
	VALUES (NEW.src, NEW.uri, NEW.cid, NEW.val);
END;

CREATE TRIGGER IF NOT EXISTS label_state_projection_conflict_au
	AFTER UPDATE ON label_state
	WHEN NEW.trusted = 1
		AND NEW.neg = 0
		AND NEW.cid IS NOT NULL
		AND (
			NEW.exp IS NULL
			OR EXISTS (
				SELECT 1 FROM listing_label_state_expiry expiry
				WHERE expiry.src = NEW.src AND expiry.uri = NEW.uri AND expiry.val = NEW.val
					AND expiry.exp = NEW.exp
					AND expiry.exp_epoch > unixepoch('now')
			)
		)
		AND NEW.val IN ('listing-pending', 'listing-review', 'listing-error') BEGIN
	INSERT INTO listing_projection_redaction_events (src, uri, cid, val)
	VALUES (NEW.src, NEW.uri, NEW.cid, NEW.val);
END;

CREATE TRIGGER IF NOT EXISTS listing_projection_redaction_apply
	AFTER INSERT ON listing_projection_redaction_events BEGIN
	DELETE FROM public_releases
	WHERE EXISTS (
		SELECT 1 FROM public_projection_generations generation
		WHERE generation.generation = public_releases.generation
			AND (
				(NEW.val = 'listing-passed-lost' AND EXISTS (
					SELECT 1 FROM json_each(generation.required_positive_sources)
					WHERE value = NEW.src
				))
				OR (NEW.val IN ('listing-pending', 'listing-review', 'listing-error', 'listing-blocked')
					AND EXISTS (
						SELECT 1 FROM json_each(generation.required_positive_sources)
						WHERE value = NEW.src
						UNION ALL
						SELECT 1 FROM json_each(generation.accepted_state_sources)
						WHERE value = NEW.src
					))
				OR (NEW.val = '!takedown' AND EXISTS (
					SELECT 1 FROM json_each(generation.redaction_sources)
					WHERE value = NEW.src
				))
				OR (NEW.val IN ('security:yanked', 'security-yanked'))
			)
	)
	AND (
		(NEW.val = '!takedown' AND NEW.uri = public_releases.did)
		OR (
			NEW.uri = 'at://' || public_releases.did ||
				'/com.emdashcms.experimental.package.release/' || public_releases.rkey
			AND (
				(NEW.val IN ('listing-passed-lost', 'listing-pending', 'listing-review', 'listing-error', 'listing-blocked')
					AND NEW.cid = public_releases.release_cid)
				OR (NEW.val IN ('security:yanked', 'security-yanked')
					AND (NEW.cid IS NULL OR NEW.cid = public_releases.release_cid))
				OR (NEW.val = '!takedown' AND (NEW.cid IS NULL OR NEW.cid = public_releases.release_cid))
			)
		)
		OR EXISTS (
			SELECT 1 FROM public_packages package
			WHERE package.generation = public_releases.generation
				AND package.did = public_releases.did
				AND package.slug = public_releases.package
				AND NEW.uri = 'at://' || package.did ||
					'/com.emdashcms.experimental.package.profile/' || package.slug
				AND (
					(NEW.val IN ('listing-passed-lost', 'listing-pending', 'listing-review', 'listing-error', 'listing-blocked')
						AND NEW.cid = package.profile_cid)
					OR (NEW.val = '!takedown' AND (NEW.cid IS NULL OR NEW.cid = package.profile_cid))
				)
		)
	);

	UPDATE public_packages SET
		latest_version = (
			SELECT version FROM public_releases
			WHERE generation = public_packages.generation
				AND did = public_packages.did
				AND package = public_packages.slug
			ORDER BY version_sort DESC, version DESC, rkey DESC LIMIT 1
		),
		capabilities = (
			SELECT json_group_array(key) FROM (
				SELECT key FROM json_each(
					(SELECT json_extract(emdash_extension, '$.declaredAccess')
					 FROM public_releases
					 WHERE generation = public_packages.generation
						AND did = public_packages.did
						AND package = public_packages.slug
					 ORDER BY version_sort DESC, version DESC, rkey DESC LIMIT 1)
				) ORDER BY key
			)
		);

	DELETE FROM public_packages
	WHERE EXISTS (
		SELECT 1 FROM public_projection_generations generation
		WHERE generation.generation = public_packages.generation
			AND (
				(NEW.val = 'listing-passed-lost' AND EXISTS (
					SELECT 1 FROM json_each(generation.required_positive_sources)
					WHERE value = NEW.src
				))
				OR (NEW.val IN ('listing-pending', 'listing-review', 'listing-error', 'listing-blocked')
					AND EXISTS (
						SELECT 1 FROM json_each(generation.required_positive_sources)
						WHERE value = NEW.src
						UNION ALL
						SELECT 1 FROM json_each(generation.accepted_state_sources)
						WHERE value = NEW.src
					))
				OR (NEW.val = '!takedown' AND EXISTS (
					SELECT 1 FROM json_each(generation.redaction_sources)
					WHERE value = NEW.src
				))
			)
	)
	AND (
		(NEW.val = '!takedown' AND NEW.uri = public_packages.did)
		OR (
			NEW.uri = 'at://' || public_packages.did ||
				'/com.emdashcms.experimental.package.profile/' || public_packages.slug
			AND (
				(NEW.val IN ('listing-passed-lost', 'listing-pending', 'listing-review', 'listing-error', 'listing-blocked')
					AND NEW.cid = public_packages.profile_cid)
				OR (NEW.val = '!takedown' AND (NEW.cid IS NULL OR NEW.cid = public_packages.profile_cid))
			)
		)
		OR NOT EXISTS (
			SELECT 1 FROM public_releases
			WHERE generation = public_packages.generation
				AND did = public_packages.did
				AND package = public_packages.slug
		)
	);

	DELETE FROM listing_projection_redaction_events WHERE id = NEW.id;
END;

-- Generational projections make rebuilds atomic without putting every row in
-- one D1 batch. Rows for a new generation remain unreachable until the final
-- pointer flip; an interrupted rebuild can be safely retried or collected.
CREATE TABLE IF NOT EXISTS public_projection_generations (
	generation TEXT PRIMARY KEY,
	policy_mode TEXT NOT NULL CHECK (policy_mode IN ('open', 'allowlist', 'projection')),
	policy_version TEXT NOT NULL,
	policy_hash TEXT NOT NULL,
	required_positive_sources TEXT NOT NULL,
	accepted_state_sources TEXT NOT NULL,
	redaction_sources TEXT NOT NULL,
	source_epoch INTEGER NOT NULL,
	rebuild_sequence INTEGER NOT NULL UNIQUE,
	created_at TEXT NOT NULL,
	completed_at TEXT
);

CREATE TABLE IF NOT EXISTS public_projection_state (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	active_generation TEXT,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (active_generation) REFERENCES public_projection_generations(generation)
);

INSERT OR IGNORE INTO public_projection_state (id, active_generation, updated_at)
	VALUES (1, NULL, datetime('now'));

CREATE TABLE IF NOT EXISTS public_packages (
	generation TEXT NOT NULL,
	did TEXT NOT NULL,
	slug TEXT NOT NULL,
	profile_cid TEXT NOT NULL,
	type TEXT NOT NULL,
	name TEXT,
	description TEXT,
	license TEXT NOT NULL,
	authors TEXT NOT NULL,
	security TEXT NOT NULL,
	keywords TEXT,
	sections TEXT,
	last_updated TEXT,
	latest_version TEXT,
	capabilities TEXT,
	record_blob BLOB NOT NULL,
	signature_metadata TEXT,
	verified_at TEXT NOT NULL,
	indexed_at TEXT NOT NULL,
	labels_json TEXT NOT NULL DEFAULT '[]',
	projected_at TEXT NOT NULL,
	PRIMARY KEY (generation, did, slug),
	FOREIGN KEY (generation) REFERENCES public_projection_generations(generation)
		ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_public_packages_subject
	ON public_packages(did, slug, generation);

CREATE TABLE IF NOT EXISTS public_releases (
	generation TEXT NOT NULL,
	did TEXT NOT NULL,
	package TEXT NOT NULL,
	version TEXT NOT NULL,
	release_cid TEXT NOT NULL,
	rkey TEXT NOT NULL,
	version_sort TEXT NOT NULL,
	artifacts TEXT NOT NULL,
	requires TEXT,
	suggests TEXT,
	emdash_extension TEXT NOT NULL,
	repo_url TEXT,
	cts TEXT NOT NULL,
	record_blob BLOB NOT NULL,
	signature_metadata TEXT,
	verified_at TEXT NOT NULL,
	indexed_at TEXT NOT NULL,
	labels_json TEXT NOT NULL DEFAULT '[]',
	projected_at TEXT NOT NULL,
	PRIMARY KEY (generation, did, package, version),
	FOREIGN KEY (generation) REFERENCES public_projection_generations(generation)
		ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_public_releases_latest
	ON public_releases(generation, did, package, version_sort DESC, version DESC);

CREATE INDEX IF NOT EXISTS idx_public_releases_subject
	ON public_releases(did, package, version, generation);

-- Search indexes only the materialized public package snapshots. Staged
-- `packages` rows have a separate FTS table and cannot enter this one through
-- an update trigger or join mistake.
CREATE VIRTUAL TABLE IF NOT EXISTS public_packages_fts USING fts5(
	name,
	description,
	keywords,
	authors,
	sections,
	content='public_packages',
	content_rowid='rowid',
	tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS public_packages_ai AFTER INSERT ON public_packages BEGIN
	INSERT INTO public_packages_fts(rowid, name, description, keywords, authors, sections)
	VALUES (new.rowid, new.name, new.description, new.keywords, new.authors, new.sections);
END;

CREATE TRIGGER IF NOT EXISTS public_packages_au AFTER UPDATE ON public_packages BEGIN
	INSERT INTO public_packages_fts(public_packages_fts, rowid, name, description, keywords, authors, sections)
	VALUES ('delete', old.rowid, old.name, old.description, old.keywords, old.authors, old.sections);
	INSERT INTO public_packages_fts(rowid, name, description, keywords, authors, sections)
	VALUES (new.rowid, new.name, new.description, new.keywords, new.authors, new.sections);
END;

CREATE TRIGGER IF NOT EXISTS public_packages_ad AFTER DELETE ON public_packages BEGIN
	INSERT INTO public_packages_fts(public_packages_fts, rowid, name, description, keywords, authors, sections)
	VALUES ('delete', old.rowid, old.name, old.description, old.keywords, old.authors, old.sections);
END;
