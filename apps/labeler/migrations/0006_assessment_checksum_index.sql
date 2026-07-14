-- Indexes the artifact checksum so the publisher-history stage (plan W8.4) can
-- run its global, cross-publisher checksum-repeat lookup — "this exact artifact
-- was also submitted under another DID" — without scanning the assessments
-- table. Partial (`WHERE artifact_checksum IS NOT NULL`) because pre-artifact
-- lifecycle states leave the column null.

CREATE INDEX idx_assessments_artifact_checksum
	ON assessments(artifact_checksum)
	WHERE artifact_checksum IS NOT NULL;
