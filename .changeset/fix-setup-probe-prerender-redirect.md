---
"emdash": patch
---

Fix the setup probe baking a redirect to `/_emdash/admin/setup` into prerendered pages. On a build whose database is empty (e.g. CI/first deploy), the anonymous setup probe saw a missing migrations table and returned `context.redirect("/_emdash/admin/setup")`; a prerendered route serializes that into static HTML and ships the redirect to production. The probe is now skipped entirely when `context.isPrerendered` is true — there is no live visitor to send to the wizard at build time, and the build database is legitimately empty. Live (SSR) requests are unaffected.
