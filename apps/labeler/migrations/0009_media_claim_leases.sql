ALTER TABLE media_quarantine_objects ADD COLUMN lease_token TEXT;
ALTER TABLE media_quarantine_objects ADD COLUMN lease_expires_at TEXT;

CREATE INDEX media_quarantine_pending_lease
ON media_quarantine_objects(ready, expires_at, lease_expires_at, object_key);
