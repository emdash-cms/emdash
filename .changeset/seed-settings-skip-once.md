---
"emdash": patch
---

Makes seed application respect `onConflict` for site settings. The default `skip` mode now seeds settings only once: if any seeded `site:*` key already exists, the whole settings block is skipped, preserving admin-configured `site:title`/`site:tagline` across re-seeds. Use `update` to overwrite settings or `error` to fail on conflict.
