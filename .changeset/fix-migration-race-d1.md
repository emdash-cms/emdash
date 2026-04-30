---
"emdash": patch
---

Fixes a migration race on D1 where two concurrent Workers isolates could both try to apply the same migration, causing one to fail with `UNIQUE constraint failed: _emdash_migrations.name`. The losing isolate would throw before reaching auto-seed, leaving the manifest cache empty and the admin UI reporting collections as not found while the API reported them correctly. `runMigrations` now treats this specific error as benign, waits for the concurrent migrator to finish, and verifies the schema is fully migrated before returning success. Closes #762.
