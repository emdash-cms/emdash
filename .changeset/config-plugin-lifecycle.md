---
"emdash": patch
---

Fixes `plugin:install` and `plugin:activate` never running for plugins registered in the `plugins` array of `astro.config.mjs`, so setup such as `ctx.cron.schedule()` in `plugin:activate` now takes effect.

Each plugin's hooks run once, when the site first starts with that plugin. On existing sites, this happens on the first start after upgrading for every plugin in `plugins` that you have never enabled, disabled, or changed MCP access for in the admin. A `plugin:install` hook that is not safe to run on a site where the plugin is already in use will run then, so check your plugins before upgrading.

If either hook throws, EmDash logs the error and disables the plugin instead of retrying on every start. Re-enable it from the Plugins page after fixing the problem; this runs `plugin:activate` again.
