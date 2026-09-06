---
"@emdash-cms/admin": patch
---

Fixes Publish saving and awaiting the editor's latest changes before making content live. Validation errors, failed saves, and revision conflicts now stop publishing instead of promoting stale draft data.
