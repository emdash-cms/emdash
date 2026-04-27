---
"emdash": patch
---

Fixes MCP ownership checks failing with an internal error on content that has no `authorId` (seed-imported rows). Admins and editors can now edit, publish, unpublish, schedule, and restore such items; users with only own-content permissions get a clean permission error.
