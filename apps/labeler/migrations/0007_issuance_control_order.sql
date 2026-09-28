INSERT INTO service_state (key, value, updated_at)
SELECT
	'issuance_paused',
	CASE action WHEN 'pause-issuance' THEN '1' ELSE '0' END,
	created_at
FROM operator_actions
WHERE action IN ('pause-issuance', 'resume-issuance')
ORDER BY id DESC
LIMIT 1
ON CONFLICT(key) DO UPDATE SET
	value = excluded.value,
	updated_at = excluded.updated_at;

INSERT INTO service_state (key, value, updated_at)
SELECT 'issuance_control_action_id', CAST(id AS TEXT), created_at
FROM operator_actions
WHERE action IN ('pause-issuance', 'resume-issuance')
ORDER BY id DESC
LIMIT 1
ON CONFLICT(key) DO NOTHING;
