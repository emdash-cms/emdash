---
"emdash": minor
---

Adds type checking for `emdash()` options in `astro.config.mjs`. A value of the wrong type, such as `mcp: "yes"`, `maxUploadSize: "10MB"` or `toolbar: "always"`, now stops `astro dev`, `astro build` and `astro sync` with one error that lists each invalid option by its path, for example `→ at mcp`. Before, these values loaded without an error and failed later or were silently ignored. Adapter, plugin and provider descriptors are checked only for their outer shape, and `registry`, `migrations`, `middleware`, `admin.locales` and `admin.hiddenNavItems` keep their existing errors.

An unrecognized top-level option still loads, but EmDash now logs a warning. When the name is close to a known option, the warning suggests it, so `sitUrl` points to `siteUrl`.

#### What should I do?

If the config fails to load after upgrading, fix each option named in the error, for example change `mcp: "true"` to `mcp: true`. The check can't be turned off. Configurations that match the documented option types are not affected.
