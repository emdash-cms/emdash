---
"emdash": patch
---

Fixes `/_emdash/api/search/suggest` 500 error. `getSuggestions` no longer double-appends the FTS5 prefix operator `*` on top of the one `escapeQuery` already adds, so autocomplete queries like `?q=des` now return results instead of raising `SqliteError: fts5: syntax error near "*"`.
