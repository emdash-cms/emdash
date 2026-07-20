-- Rename `labellers` -> `labelers` to match the spelling every query in
-- `src/` uses (`labeler-resolver.ts`, `labels-consumer.ts`,
-- `request-policy.ts`, `index.ts`). `0001_init.sql` shipped the table as
-- `labellers` and is immutable once applied, so the correction has to land as
-- a forward migration: databases provisioned by `0001` keep `labellers` and
-- only this migration brings them to `labelers`.
--
-- No indexes, triggers, or views reference the table, so SQLite's
-- `ALTER TABLE ... RENAME TO` is sufficient — there are no explicitly-named
-- objects embedding the old spelling to recreate.

ALTER TABLE labellers RENAME TO labelers;
