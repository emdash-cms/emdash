export const BRIDGE_TEST_SCHEMA = `
	CREATE TABLE _plugin_storage (
		plugin_id TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL,
		data TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
		updated_at TEXT DEFAULT CURRENT_TIMESTAMP, revision TEXT,
		PRIMARY KEY (plugin_id, collection, id)
	);
	CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT NOT NULL, revision TEXT NOT NULL);
	CREATE TABLE _emdash_collections (slug TEXT PRIMARY KEY, has_seo INTEGER DEFAULT 0);
	CREATE TABLE ec_posts (
		id TEXT PRIMARY KEY, slug TEXT, status TEXT, author_id TEXT, created_at TEXT, updated_at TEXT,
		version INTEGER, locale TEXT, translation_group TEXT, deleted_at TEXT, title TEXT
	);
	CREATE TABLE media (
		id TEXT PRIMARY KEY, filename TEXT, mime_type TEXT, size INTEGER, storage_key TEXT,
		status TEXT, created_at TEXT, alt TEXT, caption TEXT, width INTEGER, height INTEGER,
		focal_x REAL, focal_y REAL, content_hash TEXT, blurhash TEXT, dominant_color TEXT,
		author_id TEXT, folder_id TEXT
	);
`;
