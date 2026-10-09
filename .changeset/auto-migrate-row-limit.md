---
"emdash": patch
---

Fixes sites on Cloudflare Workers in the default `auto` migration mode serving pages without their content, with a 200 status, after an upgrade whose migrations a request could not finish.

Such a site now answers with a 503 response until its migrations are applied, so uptime checks notice it. A deployed Worker also no longer starts a migration that processes every entry and revision of a large site, such as the datetime normalization from 0.39.0; it answers with 503 until `emdash migrate` applies it. Node deployments and the development server are unaffected.

#### What should I do?

If your site runs on Workers in `auto` mode and upgrades from 0.38 or earlier, run `emdash migrate` before you deploy, as described in [Apply large content migrations from the CLI](https://docs.emdashcms.com/deployment/core-migrations/#apply-large-content-migrations-from-the-cli).

If a site answers with 503 after an upgrade, read the Worker log. When it names a pending migration, apply it with `emdash migrate`. When it reports a held migration lock, follow [Release a stuck migration lock](https://docs.emdashcms.com/deployment/core-migrations/#release-a-stuck-migration-lock).
