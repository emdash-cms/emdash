---
"emdash": patch
---

Fixes seed application crashing with a raw UNIQUE-constraint error when a seeded entry's slug collides with an entry in the trash. Trashed collisions are now skipped — deliberately deleted content is never resurrected or overwritten — in `skip` and `update` modes, and reported as a clear conflict message in `error` mode. This also fixes the dev setup bypass failing on databases where seeded content had been moved to the trash.
