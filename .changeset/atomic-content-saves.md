---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes concurrent content saves using the same `_rev` so a stale save returns `CONFLICT` instead of overwriting newer edits. The check covers collections with and without revisions, including saves delayed by a plugin hook. Clients that omit `_rev` keep their existing blind-write behavior.

The admin editor queues SEO, author, and publication-date changes with its other saves, preventing those controls from conflicting with the editor's own autosave.

Keeps site exports working during the upcoming autosave-history upgrade. Deploy this patch to all application instances before applying that upgrade on a rolling deployment.
