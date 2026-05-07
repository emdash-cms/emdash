---
"@emdash-cms/registry-lexicons": minor
---

Adds `RECORD_NSIDS` and `QUERY_NSIDS` const arrays alongside the existing `NSID` map. They enumerate the record-shaped and query-shaped lexicons in this package so consumers (e.g. tooling that builds OAuth `repo:` / `rpc:` scopes) can derive their list from the lexicon set instead of hand-rolling one that drifts.
