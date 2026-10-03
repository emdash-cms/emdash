---
"@emdash-cms/admin": patch
---

Fixes the field editor silently closing and discarding changes when the server rejects a field update, such as toggling `required` or `unique` on a field that already has content (which needs a manual content migration). The dialog now stays open and shows the server's error message instead of the toggle looking like it reverted on its own.
