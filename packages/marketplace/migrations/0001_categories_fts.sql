-- Add structured categories and FTS5 full-text search

-- Categories table
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  sort_order INTEGER DEFAULT 0
);

-- Plugin-to-category join table (max 3 per plugin, enforced in application code)
CREATE TABLE IF NOT EXISTS plugin_categories (
  plugin_id TEXT NOT NULL REFERENCES plugins(id),
  category_id TEXT NOT NULL REFERENCES categories(id),
  PRIMARY KEY(plugin_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_plugin_categories_category ON plugin_categories(category_id);

-- FTS5 virtual table for full-text search on plugins
CREATE VIRTUAL TABLE IF NOT EXISTS plugins_fts USING fts5(
  name, description, keywords,
  content='plugins', content_rowid='rowid'
);

-- Keep FTS index in sync with plugins table
CREATE TRIGGER IF NOT EXISTS plugins_fts_insert AFTER INSERT ON plugins BEGIN
  INSERT INTO plugins_fts(rowid, name, description, keywords)
  VALUES (NEW.rowid, NEW.name, NEW.description, NEW.keywords);
END;

CREATE TRIGGER IF NOT EXISTS plugins_fts_delete AFTER DELETE ON plugins BEGIN
  INSERT INTO plugins_fts(plugins_fts, rowid, name, description, keywords)
  VALUES ('delete', OLD.rowid, OLD.name, OLD.description, OLD.keywords);
END;

CREATE TRIGGER IF NOT EXISTS plugins_fts_update AFTER UPDATE ON plugins BEGIN
  INSERT INTO plugins_fts(plugins_fts, rowid, name, description, keywords)
  VALUES ('delete', OLD.rowid, OLD.name, OLD.description, OLD.keywords);
  INSERT INTO plugins_fts(rowid, name, description, keywords)
  VALUES (NEW.rowid, NEW.name, NEW.description, NEW.keywords);
END;

-- Backfill FTS index with any existing plugin rows
INSERT INTO plugins_fts(plugins_fts) VALUES ('rebuild');

-- Seed default categories
INSERT OR IGNORE INTO categories (id, slug, name, description, sort_order) VALUES
  ('cat_seo', 'seo', 'SEO & Metadata', 'Search engine optimization and meta tags', 1),
  ('cat_forms', 'forms', 'Forms & Input', 'Form builders and input handling', 2),
  ('cat_analytics', 'analytics', 'Analytics & Tracking', 'Analytics and visitor tracking', 3),
  ('cat_email', 'email', 'Email & Notifications', 'Email sending and notification systems', 4),
  ('cat_media', 'media', 'Media & Images', 'Image processing and media management', 5),
  ('cat_social', 'social', 'Social & Sharing', 'Social media and sharing tools', 6),
  ('cat_security', 'security', 'Security & Auth', 'Security and authentication tools', 7),
  ('cat_devtools', 'devtools', 'Developer Tools', 'Debugging and development utilities', 8),
  ('cat_content', 'content', 'Content & Editing', 'Content editing and management', 9),
  ('cat_performance', 'performance', 'Performance & Caching', 'Performance optimization and caching', 10),
  ('cat_migration', 'migration', 'Migration & Import', 'Data migration and content import', 11),
  ('cat_ecommerce', 'ecommerce', 'E-commerce', 'E-commerce and payment tools', 12);
