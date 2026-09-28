CREATE INDEX IF NOT EXISTS assessments_public_order
ON assessments(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS operator_actions_subject_decision
ON operator_actions(subject_uri, subject_cid, action, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS issued_labels_assessment_sequence
ON issued_labels(assessment_id, sequence)
WHERE assessment_id IS NOT NULL;
