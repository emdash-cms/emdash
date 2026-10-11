---
"emdash": patch
---

Fixes `emdash seed` to avoid leaking duplicate media rows and adds `--skip-media` for storage-less seeds.

- `$media` references now deduplicate against existing ready media rows by content hash, so re-running `emdash seed ... --on-conflict=update` reuses the same rows instead of creating new ones each time.
- New `--skip-media` flag resolves `$media` references to external URLs without downloading files or creating local `./uploads`, which is useful when seeding a site whose media lives in remote object storage.
