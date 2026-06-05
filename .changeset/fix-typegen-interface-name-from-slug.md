---
"emdash": patch
---

Fix generated TypeScript interface names in `emdash-env.d.ts` being derived from a collection's human display label (`labelSingular`) rather than its slug. Labels are arbitrary and user-controlled, so a label with spaces/punctuation produced a syntactically invalid identifier (e.g. `Book (do not use)` → `export interface Book(donotuse)`) and two collections sharing a label collapsed to the same name (duplicate identifier) — both rejected by `astro check`/`tsc`. Interface names now derive from the slug, which is constrained to `/^[a-z][a-z0-9_]*$/` and unique, so PascalCasing it always yields a valid, collision-free identifier. The `EmDashCollections` augmentation map references the same names.
