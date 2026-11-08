---
"emdash": patch
"@emdash-cms/plugin-test": patch
---

Restarts EmDash plugins and the sandbox runner when Vite re-optimizes dependencies in installed Cloudflare `astro dev` projects on Astro 7 (Vite 8) or later. The admin package is now pre-bundled, but public-page edits still require full server reloads.

On Node and Cloudflare, admin and API requests arriving during development-runtime teardown can fail CMS initialization, and anonymous pages may render without CMS data. Retry after the restart completes; a second runtime will not start while the cached runtime is shutting down.

Keeps workerd-backed plugin tests loading with this EmDash release. Existing plugin tests need no changes.
