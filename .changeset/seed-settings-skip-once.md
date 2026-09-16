---
"emdash": patch
---

Makes seed application respect `onConflict` for site settings. In the default `skip` mode, each seeded `site:*` key is created only if the option is absent, so existing admin-managed `site:title`/`site:tagline` values survive re-seeding while missing keys are still filled in. Use `update` to overwrite the whole settings block, or `error` to fail when any seeded setting already exists.
