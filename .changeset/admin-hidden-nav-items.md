---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds `admin.hiddenNavItems` to hide built-in admin areas a site doesn't use. Set it to any of `calendar`, `media`, `comments`, `menus`, `redirects`, `widgets`, `sections`, `bylines`, and `import`, for example `admin: { hiddenNavItems: ["comments", "redirects"] }`. Hidden areas disappear from the sidebar, the command palette, and the dashboard's Upload Media and Scheduled shortcuts. The pages and API routes stay reachable for users with the required role. An unknown name fails the build.
