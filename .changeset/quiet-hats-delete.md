---
"emdash": patch
---

Fixes `emdash schema delete --force` so it can delete a collection that still has content. The flag only skipped the confirmation prompt and was never sent to the API, which then refused with "Use force: true to delete". `EmDashClient.deleteCollection` accepts `{ force: true }` for the same purpose.
