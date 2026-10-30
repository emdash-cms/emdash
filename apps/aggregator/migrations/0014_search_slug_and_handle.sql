-- Make package search match each package's slug and its publisher's handle.
--
-- FTS5 tables can't gain columns, so both search tables are rebuilt with two
-- more: `slug` and `search_handle`. An external-content FTS table indexes only
-- columns of its content table, so `packages` and `public_packages` carry the
-- publisher's `search_handle`, which triggers keep in step with
-- `known_publishers.handle`.

-- The handle without its top-level domain, and without `.bsky.social` for
-- Bluesky-hosted handles: many publishers share those labels, so indexing them
-- would make a search for `social` or `com` list all of those publishers'
-- packages.
-- `rtrim(handle, <every character of handle except dots>)` cuts the last label.
CREATE VIEW IF NOT EXISTS publisher_search_handles AS
SELECT
	did,
	CASE
		WHEN handle LIKE '%.bsky.social' THEN substr(handle, 1, length(handle) - length('.bsky.social'))
		ELSE rtrim(rtrim(handle, replace(handle, '.', '')), '.')
	END AS search_handle
FROM known_publishers
WHERE handle IS NOT NULL;

DROP TRIGGER IF EXISTS packages_ai;
DROP TRIGGER IF EXISTS packages_au;
DROP TRIGGER IF EXISTS packages_ad;
DROP TABLE IF EXISTS packages_fts;

DROP TRIGGER IF EXISTS public_packages_ai;
DROP TRIGGER IF EXISTS public_packages_au;
DROP TRIGGER IF EXISTS public_packages_ad;
DROP TABLE IF EXISTS public_packages_fts;

ALTER TABLE packages ADD COLUMN search_handle TEXT;
ALTER TABLE public_packages ADD COLUMN search_handle TEXT;

UPDATE packages SET search_handle = (
	SELECT search_handle FROM publisher_search_handles WHERE did = packages.did
);
UPDATE public_packages SET search_handle = (
	SELECT search_handle FROM publisher_search_handles WHERE did = public_packages.did
);

CREATE VIRTUAL TABLE packages_fts USING fts5(
	name,
	description,
	keywords,
	authors,
	sections,
	slug,
	search_handle,
	content='packages',
	content_rowid='rowid',
	tokenize='porter unicode61 remove_diacritics 2'
);
INSERT INTO packages_fts(packages_fts) VALUES ('rebuild');

CREATE VIRTUAL TABLE public_packages_fts USING fts5(
	name,
	description,
	keywords,
	authors,
	sections,
	slug,
	search_handle,
	content='public_packages',
	content_rowid='rowid',
	tokenize='porter unicode61 remove_diacritics 2'
);
INSERT INTO public_packages_fts(public_packages_fts) VALUES ('rebuild');

-- The insert triggers index the row first and set `search_handle` after, so
-- the update trigger removes exactly the terms that were indexed.
CREATE TRIGGER packages_ai AFTER INSERT ON packages BEGIN
	INSERT INTO packages_fts(rowid, name, description, keywords, authors, sections, slug, search_handle)
	VALUES (new.rowid, new.name, new.description, new.keywords, new.authors, new.sections, new.slug, new.search_handle);
	UPDATE packages
	SET search_handle = (SELECT search_handle FROM publisher_search_handles WHERE did = new.did)
	WHERE rowid = new.rowid
		AND search_handle IS NOT (SELECT search_handle FROM publisher_search_handles WHERE did = new.did);
END;

CREATE TRIGGER packages_au AFTER UPDATE ON packages BEGIN
	INSERT INTO packages_fts(packages_fts, rowid, name, description, keywords, authors, sections, slug, search_handle)
	VALUES ('delete', old.rowid, old.name, old.description, old.keywords, old.authors, old.sections, old.slug, old.search_handle);
	INSERT INTO packages_fts(rowid, name, description, keywords, authors, sections, slug, search_handle)
	VALUES (new.rowid, new.name, new.description, new.keywords, new.authors, new.sections, new.slug, new.search_handle);
END;

CREATE TRIGGER packages_ad AFTER DELETE ON packages BEGIN
	INSERT INTO packages_fts(packages_fts, rowid, name, description, keywords, authors, sections, slug, search_handle)
	VALUES ('delete', old.rowid, old.name, old.description, old.keywords, old.authors, old.sections, old.slug, old.search_handle);
END;

CREATE TRIGGER public_packages_ai AFTER INSERT ON public_packages BEGIN
	INSERT INTO public_packages_fts(rowid, name, description, keywords, authors, sections, slug, search_handle)
	VALUES (new.rowid, new.name, new.description, new.keywords, new.authors, new.sections, new.slug, new.search_handle);
	UPDATE public_packages
	SET search_handle = (SELECT search_handle FROM publisher_search_handles WHERE did = new.did)
	WHERE rowid = new.rowid
		AND search_handle IS NOT (SELECT search_handle FROM publisher_search_handles WHERE did = new.did);
END;

CREATE TRIGGER public_packages_au AFTER UPDATE ON public_packages BEGIN
	INSERT INTO public_packages_fts(public_packages_fts, rowid, name, description, keywords, authors, sections, slug, search_handle)
	VALUES ('delete', old.rowid, old.name, old.description, old.keywords, old.authors, old.sections, old.slug, old.search_handle);
	INSERT INTO public_packages_fts(rowid, name, description, keywords, authors, sections, slug, search_handle)
	VALUES (new.rowid, new.name, new.description, new.keywords, new.authors, new.sections, new.slug, new.search_handle);
END;

CREATE TRIGGER public_packages_ad AFTER DELETE ON public_packages BEGIN
	INSERT INTO public_packages_fts(public_packages_fts, rowid, name, description, keywords, authors, sections, slug, search_handle)
	VALUES ('delete', old.rowid, old.name, old.description, old.keywords, old.authors, old.sections, old.slug, old.search_handle);
END;

CREATE TRIGGER known_publishers_search_handle_ai AFTER INSERT ON known_publishers
WHEN new.handle IS NOT NULL BEGIN
	UPDATE packages
	SET search_handle = (SELECT search_handle FROM publisher_search_handles WHERE did = new.did)
	WHERE did = new.did
		AND search_handle IS NOT (SELECT search_handle FROM publisher_search_handles WHERE did = new.did);
	UPDATE public_packages
	SET search_handle = (SELECT search_handle FROM publisher_search_handles WHERE did = new.did)
	WHERE did = new.did
		AND search_handle IS NOT (SELECT search_handle FROM publisher_search_handles WHERE did = new.did);
END;

CREATE TRIGGER known_publishers_search_handle_au AFTER UPDATE OF handle ON known_publishers
WHEN old.handle IS NOT new.handle BEGIN
	UPDATE packages
	SET search_handle = (SELECT search_handle FROM publisher_search_handles WHERE did = new.did)
	WHERE did = new.did
		AND search_handle IS NOT (SELECT search_handle FROM publisher_search_handles WHERE did = new.did);
	UPDATE public_packages
	SET search_handle = (SELECT search_handle FROM publisher_search_handles WHERE did = new.did)
	WHERE did = new.did
		AND search_handle IS NOT (SELECT search_handle FROM publisher_search_handles WHERE did = new.did);
END;

CREATE TRIGGER known_publishers_search_handle_ad AFTER DELETE ON known_publishers BEGIN
	UPDATE packages SET search_handle = NULL WHERE did = old.did AND search_handle IS NOT NULL;
	UPDATE public_packages SET search_handle = NULL WHERE did = old.did AND search_handle IS NOT NULL;
END;
