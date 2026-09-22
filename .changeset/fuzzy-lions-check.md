---
"emdash": minor
---

Adds `GET /_emdash/api/health` so external tools can confirm an EmDash site is reachable and whether its plugin registry is enabled. The anonymous response does not query the database and permits cross-origin reads.
