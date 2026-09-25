---
"emdash": patch
---

Fixes upgrades that hang or fail on the `035_bounded_404_log` migration when `_emdash_404_log` holds many rows, on PostgreSQL, SQLite, and Cloudflare D1. Deduplicating the 404 log slowed down sharply as the log grew, so a log with a few hundred thousand entries never finished, held the migration lock, and on PostgreSQL could run the server out of memory. The migration now takes about as long as reading the log once, so sites no longer need to empty the 404 log before upgrading.

#### Sites that already failed on this migration

On SQLite and D1, a site whose earlier attempt stopped partway kept failing on every start with a unique-constraint error on `_emdash_404_log`. The migration now finishes deduplicating on the next start. If startup instead reports that the migration lock is held, [release the stuck migration lock](https://docs.emdashcms.com/deployment/core-migrations/#release-a-stuck-migration-lock) first. PostgreSQL sites were rolled back to their pre-migration state and simply complete on the next start.
