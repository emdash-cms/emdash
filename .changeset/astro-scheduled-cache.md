---
"@emdash-cms/cloudflare": minor
---

Fixes scheduled publishing cache invalidation so newly published content is served after the scheduled task completes.

This release requires stable Astro 6.0.0 or later. Astro 6 prereleases no longer satisfy the package's peer dependency range.

#### What should I do?

Upgrade Astro to version 6.0.0 or later before updating `@emdash-cms/cloudflare` if the site still uses an Astro 6 prerelease.
