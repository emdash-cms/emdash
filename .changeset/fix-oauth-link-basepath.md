---
"@emdash-cms/admin": patch
---

Fixes OAuth provider login buttons (Google, GitHub) generating broken URLs on the admin login page. Non-admin `/_emdash/` paths are no longer routed through TanStack Router, which was incorrectly prepending the admin basepath and causing 404s.
