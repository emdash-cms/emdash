---
"emdash": patch
---

Fixes the OpenAPI document for content taxonomy terms so it matches the shipped route. The documented `PUT /_emdash/api/content/{collection}/{id}/terms` path has been removed; use `GET` or `POST /_emdash/api/content/{collection}/{id}/terms/{taxonomy}` instead. The `taxonomy` path parameter is required, and `POST` validates that every term id belongs to that taxonomy.
