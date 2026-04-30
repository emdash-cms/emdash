---
"emdash": patch
---

Fixes admin field editor selection going stale after `emdash seed` (#776). When a seed creates or updates collections, fields, or taxonomy definitions, `applySeed` now clears the persisted `emdash:manifest_cache` row. Without this, a previously-built manifest survived the seed and kept describing fields with their old `kind` -- which is how a field declared as `type: "json"` in a seed could keep rendering as the markdown textarea in the admin even after the database was updated. The seed CLI also prints a hint reminding users to restart the dev server after schema changes, since the in-memory cache lives in the dev server's process and the CLI cannot reach it.
