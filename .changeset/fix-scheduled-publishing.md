---
"emdash": patch
---

Fix scheduled posts never becoming published. Two independent bugs:

1. **No auto-publish mechanism** -- `ContentRepository.findReadyToPublish()` existed but was never called outside tests. Added `publishScheduledContent()` that runs on every cron tick (Node scheduler or Cloudflare piggyback), iterates all collections, and publishes items whose `scheduled_at` has passed via the standard `publish()` path. Also wired `runtime.tickCron()` into middleware so the piggyback scheduler actually fires on Cloudflare Workers.

2. **SQLite format mismatch (fixes #917)** -- `scheduled_at` is stored as ISO 8601 with `T` and `Z` (e.g. `2026-05-05T01:41:59.000Z`) but SQLite's `datetime('now')` returns `YYYY-MM-DD HH:MM:SS`. Lexicographic comparison sees `T` (0x54) > space (0x20), so `scheduled_at <= datetime('now')` was always false. Fixed by wrapping both sides in `datetime()` on SQLite in `loader.ts`, `content.ts`, and `snapshot.ts`.
