CREATE TABLE IF NOT EXISTS authors (
  id TEXT PRIMARY KEY,
  github_id TEXT UNIQUE,
  name TEXT NOT NULL,
  email TEXT,
  avatar_url TEXT,
  verified INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  author_id TEXT NOT NULL REFERENCES authors(id),
  repository_url TEXT,
  homepage_url TEXT,
  license TEXT,
  capabilities TEXT NOT NULL,
  keywords TEXT,
  has_icon INTEGER DEFAULT 0,
  install_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_plugins_author ON plugins(author_id);

CREATE TABLE IF NOT EXISTS plugin_versions (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugins(id),
  version TEXT NOT NULL,
  min_emdash_version TEXT,
  bundle_key TEXT NOT NULL,
  bundle_size INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  changelog TEXT,
  readme TEXT,
  has_icon INTEGER DEFAULT 0,
  screenshot_count INTEGER DEFAULT 0,
  capabilities TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  workflow_id TEXT,
  audit_id TEXT,
  audit_verdict TEXT,
  image_audit_id TEXT,
  image_audit_verdict TEXT,
  published_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(plugin_id, version)
);
CREATE INDEX IF NOT EXISTS idx_plugin_versions_plugin ON plugin_versions(plugin_id);
CREATE INDEX IF NOT EXISTS idx_plugin_versions_plugin_status ON plugin_versions(plugin_id, status);

CREATE TABLE IF NOT EXISTS plugin_audits (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  verdict TEXT NOT NULL,
  risk_score INTEGER NOT NULL,
  summary TEXT NOT NULL,
  findings TEXT NOT NULL,
  model TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (plugin_id) REFERENCES plugins(id)
);
CREATE INDEX IF NOT EXISTS idx_plugin_audits_plugin_version ON plugin_audits(plugin_id, version);

CREATE TABLE IF NOT EXISTS plugin_image_audits (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  verdict TEXT NOT NULL,
  findings TEXT NOT NULL,
  model TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (plugin_id) REFERENCES plugins(id)
);
CREATE INDEX IF NOT EXISTS idx_plugin_image_audits_pv ON plugin_image_audits(plugin_id, version);

CREATE TABLE IF NOT EXISTS installs (
  plugin_id TEXT NOT NULL REFERENCES plugins(id),
  site_hash TEXT NOT NULL,
  version TEXT NOT NULL,
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (plugin_id, site_hash)
);
CREATE INDEX IF NOT EXISTS idx_installs_plugin ON installs(plugin_id);

CREATE TABLE IF NOT EXISTS themes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  author_id TEXT NOT NULL REFERENCES authors(id),
  preview_url TEXT NOT NULL,
  demo_url TEXT,
  repository_url TEXT,
  homepage_url TEXT,
  license TEXT,
  keywords TEXT,
  has_thumbnail INTEGER DEFAULT 0,
  screenshot_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_themes_author ON themes(author_id);
