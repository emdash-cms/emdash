---
"emdash": patch
---

Adds always-on `db.*` and `cache.*` Server-Timing fields so render-phase performance is diagnosable in production. Each request now emits `db.total` (cumulative DB ms), `db.count` (query count), `db.first` / `db.last` (first/last query offset from request start), and `cache.hit` / `cache.miss` (request-scoped cache stats). The Kysely log hook is now always installed so counters work without setting `EMDASH_QUERY_LOG`.
