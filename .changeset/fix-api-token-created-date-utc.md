---
"@emdash-cms/admin": patch
---

Fixes the API token created date showing the wrong day for viewers outside UTC. The timezone-less stored timestamp is now parsed as UTC, matching the other admin dates.
