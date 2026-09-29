CREATE UNIQUE INDEX IF NOT EXISTS idx_known_publishers_handle
ON known_publishers(handle)
WHERE handle IS NOT NULL;
