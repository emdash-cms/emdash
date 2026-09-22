CREATE TABLE IF NOT EXISTS eval_runs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	idempotency_key TEXT NOT NULL UNIQUE
		CHECK (length(idempotency_key) BETWEEN 8 AND 200),
	actor_did TEXT NOT NULL CHECK (length(actor_did) BETWEEN 1 AND 500),
	actor_role TEXT NOT NULL CHECK (actor_role = 'admin'),
	reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
	status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
	artifact_key TEXT CHECK (artifact_key IS NULL OR length(artifact_key) <= 1024),
	dataset_hash TEXT CHECK (dataset_hash IS NULL OR length(dataset_hash) = 64),
	budget_passed INTEGER CHECK (budget_passed IS NULL OR budget_passed IN (0, 1)),
	candidate_hash TEXT CHECK (candidate_hash IS NULL OR length(candidate_hash) = 64),
	baseline_run_id INTEGER REFERENCES eval_runs(id),
	baseline_hash TEXT CHECK (baseline_hash IS NULL OR length(baseline_hash) = 64),
	comparison_hash TEXT CHECK (comparison_hash IS NULL OR length(comparison_hash) = 64),
	promotion_challenge_hash TEXT
		CHECK (promotion_challenge_hash IS NULL OR length(promotion_challenge_hash) = 64),
	workflow_instance_id TEXT
		CHECK (workflow_instance_id IS NULL OR length(workflow_instance_id) <= 200),
	result_json TEXT CHECK (result_json IS NULL OR length(result_json) <= 65536),
	comparison_json TEXT CHECK (comparison_json IS NULL OR length(comparison_json) <= 262144),
	report_markdown TEXT CHECK (report_markdown IS NULL OR length(report_markdown) <= 65536),
	failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) <= 100),
	failure_summary TEXT CHECK (failure_summary IS NULL OR length(failure_summary) <= 500),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	completed_at TEXT,
	CHECK (
		(baseline_run_id IS NULL AND baseline_hash IS NULL AND comparison_hash IS NULL
			AND promotion_challenge_hash IS NULL AND comparison_json IS NULL)
		OR
		(baseline_run_id IS NOT NULL AND baseline_hash IS NOT NULL AND comparison_hash IS NOT NULL
			AND promotion_challenge_hash IS NOT NULL AND comparison_json IS NOT NULL)
	),
	CHECK (
		(status = 'running' AND result_json IS NULL AND report_markdown IS NULL
			AND failure_code IS NULL AND failure_summary IS NULL AND completed_at IS NULL)
		OR
		(status = 'succeeded' AND artifact_key IS NOT NULL AND dataset_hash IS NOT NULL
			AND budget_passed IS NOT NULL AND candidate_hash IS NOT NULL
			AND result_json IS NOT NULL AND report_markdown IS NOT NULL
			AND failure_code IS NULL AND failure_summary IS NULL AND completed_at IS NOT NULL)
		OR
		(status = 'failed' AND artifact_key IS NULL AND dataset_hash IS NULL
			AND budget_passed IS NULL AND candidate_hash IS NULL AND baseline_run_id IS NULL
			AND baseline_hash IS NULL AND comparison_hash IS NULL
			AND promotion_challenge_hash IS NULL AND result_json IS NULL
			AND comparison_json IS NULL AND report_markdown IS NULL
			AND failure_code IS NOT NULL AND failure_summary IS NOT NULL
			AND completed_at IS NOT NULL)
	)
);

CREATE INDEX IF NOT EXISTS eval_runs_status_created
	ON eval_runs(status, created_at, id);

CREATE INDEX IF NOT EXISTS eval_runs_dataset_completed
	ON eval_runs(dataset_hash, completed_at, id)
	WHERE status = 'succeeded';

CREATE UNIQUE INDEX IF NOT EXISTS eval_runs_workflow_instance
	ON eval_runs(workflow_instance_id)
	WHERE workflow_instance_id IS NOT NULL;
