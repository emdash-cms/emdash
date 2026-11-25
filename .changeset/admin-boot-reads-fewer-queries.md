---
"emdash": patch
---

Speeds up two requests every admin content list or screen makes on remote databases: `GET /_emdash/api/content/{collection}/authors` reads the authors in one query instead of two in sequence, and `GET /_emdash/api/admin/comments/counts` counts all four statuses in one query instead of four.
