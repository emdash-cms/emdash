---
"emdash": patch
---

Fixes search silently returning no results on Node.js builds whose SQLite lacks FTS5. Search and suggestion requests return `503 SEARCH_UNAVAILABLE` with an explanation; enabling or rebuilding search reports the same cause. Programmatic search functions throw the exported `SearchUnavailableError`, which search pages can catch to display an unavailable message. After switching to a build with FTS5 support, enable search for any collections whose setup failed.
