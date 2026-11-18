---
"emdash": patch
---

Fixes the plugin registry image proxy failing when a release record declares an artifact as a legacy `{ cid }` blob. The proxy now fetches such artifacts from their URL, as release verification does.
