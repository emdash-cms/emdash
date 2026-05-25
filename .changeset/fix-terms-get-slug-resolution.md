---
"emdash": patch
---

Fixes `GET /_emdash/api/content/{collection}/{id}/terms/{taxonomy}` returning an empty list when the entry is addressed by its slug. Term assignments are stored under the canonical entry ID, and the POST handler already resolves a slug to that ID before writing; the GET handler now performs the same resolution before reading, so a slug-addressed request returns the assigned terms instead of an empty list.
