ALTER TABLE eval_runs ADD COLUMN lease_token TEXT;
ALTER TABLE eval_runs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE eval_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1);

CREATE INDEX eval_runs_running_lease
	ON eval_runs(status, lease_expires_at, id)
	WHERE status = 'running';
