-- Monotonic tombstone counter on subjects, the structural close of the
-- delete-vs-{create,verify,rerun} race class. Every delete of a `(uri, cid)`
-- increments `delete_generation`; a create/verify/rerun captures the generation
-- when it reads state / verifies and CAS-guards its subject-undelete, run
-- creation, and label issuance on the generation not having advanced. A stale
-- operation (older generation) is rejected as obsolete; an operation that began
-- AFTER the delete reads the new generation and proceeds (delete-then-republish
-- still works). Backfilled to 0 for existing rows (never-deleted baseline).
ALTER TABLE subjects ADD COLUMN delete_generation INTEGER NOT NULL DEFAULT 0;
