ALTER TABLE findings ADD COLUMN severity TEXT;

CREATE TABLE IF NOT EXISTS code_review_budget (
	scope TEXT NOT NULL,
	window_start TEXT NOT NULL,
	count INTEGER NOT NULL,
	PRIMARY KEY (scope, window_start)
);
