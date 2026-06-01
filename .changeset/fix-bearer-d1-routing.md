---
"emdash": patch
---

Fix D1 read-your-writes consistency for Bearer-token API clients by treating `Authorization: Bearer ...` headers as authenticated when routing reads and persisting session bookmarks. Previously only cookie-based sessions set `isAuthenticated`, so PAT-authenticated reads hit unconstrained replicas and bookmarks were discarded. (#1046)
