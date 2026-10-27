---
"@emdash-cms/admin": patch
---

Fixes the first-login welcome dialog showing the EmDash icon on sites that set a custom `admin.logo`. The dialog now shows the configured logo, like the sidebar and login screens, and falls back to the EmDash icon when no logo is set.
