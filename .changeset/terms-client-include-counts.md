---
"emdash": patch
---

Fixes `client.terms()` so dictionary consumers can skip usage counts. `client.terms("tag", { includeCounts: false })` leaves `count` off each term, and counts stay enabled by default.
