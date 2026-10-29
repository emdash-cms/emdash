---
"emdash": patch
---

Fixes the visual editor toolbar to detect and publish unpublished changes for every annotated entry on the page, rather than only the first entry on load or the last entry saved. If an entry fails to publish, other pending entries are still published and the page stays open so failed entries can be retried without republishing entries that already succeeded.
