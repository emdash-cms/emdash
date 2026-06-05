---
"emdash": patch
---

Fix frontend pages redirecting to `/_emdash/admin/setup` on a fully set-up site. The anonymous fast-path "setup probe" in the Astro middleware queries `_emdash_migrations` to detect a fresh, un-migrated database, but its `catch` block treated **every** error as "fresh install" — so a transient DB failure (D1 connection loss, replica unavailable, query timeout, cold-start race, locked SQLite) wrongly bounced real visitors to the setup wizard. The probe now only redirects when the error is a genuinely-missing table (via the shared `isMissingTableError` helper) and otherwise renders the page normally. The `setupVerified` flag is also moved onto a `globalThis` `Symbol.for` singleton so it isn't duplicated across SSR chunks, which had caused the probe to re-run far more often than intended (and each re-run was another chance to hit the bug).
