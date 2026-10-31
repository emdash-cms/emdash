---
"emdash": patch
---

Fixes `/_emdash/api/search` silently returning no results on Node.js builds whose SQLite lacks FTS5. Search and suggestion requests return `503 SEARCH_UNAVAILABLE` with an explanation; enabling or rebuilding search reports the same cause. MCP search errors also use the `SEARCH_UNAVAILABLE` code. Programmatic search functions throw the exported `SearchUnavailableError`. Server-rendered search pages that do not catch it return an error until FTS5 is available. Catch this error to display an unavailable message. After switching to a build with FTS5 support, enable search for any collections whose setup failed.
