---
"emdash": patch
---

Restarts EmDash plugins and the sandbox runner when Vite re-optimizes dependencies in installed Cloudflare `astro dev` projects on Astro 7 (Vite 8) or later. In those projects, the admin package is now pre-bundled, but public-page edits still require full server reloads.

During runtime teardown, admin and API requests can fail CMS initialization, and anonymous pages may render without CMS data. Retry after the restart completes; a second runtime will not start while the cached runtime is shutting down. If teardown never finishes, restart the development server before retrying.
