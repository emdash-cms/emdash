ALTER TABLE findings ADD COLUMN finding_index INTEGER;

ALTER TABLE assessments ADD COLUMN finalization_idempotency_key TEXT;

CREATE UNIQUE INDEX assessments_finalization_idempotency
ON assessments(finalization_idempotency_key)
WHERE finalization_idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX findings_assessment_index
ON findings(assessment_id, finding_index)
WHERE finding_index IS NOT NULL;
