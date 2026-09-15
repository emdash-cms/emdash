---
"emdash": patch
---

Adds an optional `urlTemplate` prop to the `RecentPosts` widget (defaults to `/posts/:slug`, matching the prior hardcoded behavior) so sites using a catch-all route (e.g. `/:slug`) can override it. Companion fix to PR #1387, which added the same override (`routeMap`) to `LiveSearch`.
