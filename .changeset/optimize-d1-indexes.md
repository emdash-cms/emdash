---
"emdash": patch
---

Optimizes D1 database indexes to eliminate full table scans in admin panel. Adds
composite indexes on ec\_\* content tables for common query patterns (deleted_at +
updated_at/created_at + id) and rewrites comment counting to use partial indexes.
Reduces D1 row reads by 90%+ for dashboard operations.
