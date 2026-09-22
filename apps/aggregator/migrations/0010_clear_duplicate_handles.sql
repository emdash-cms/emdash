UPDATE known_publishers AS publisher
SET handle = NULL,
    handle_resolved_at = NULL
WHERE handle IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM known_publishers AS preferred
    WHERE preferred.handle = publisher.handle
      AND (
        COALESCE(preferred.handle_resolved_at, '') > COALESCE(publisher.handle_resolved_at, '')
        OR (
          COALESCE(preferred.handle_resolved_at, '') = COALESCE(publisher.handle_resolved_at, '')
          AND preferred.did < publisher.did
        )
      )
  );
