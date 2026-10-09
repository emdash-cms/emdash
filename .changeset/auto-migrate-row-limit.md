---
"emdash": patch
---

Fixes sites on Cloudflare Workers in the default `auto` migration mode serving pages without their content, with a 200 status, after an upgrade whose migrations a request could not finish.

Such a site now answers with a 503 response until its migrations are applied, so uptime checks notice it. A deployed Worker also leaves migrations that rewrite every entry of a large site to `emdash migrate` instead of starting them inside a request.

#### What should I do?

If a site answers with 503 after an upgrade, read the Worker log. When it names a pending migration, apply it from the deployment machine as described in [Apply large content migrations from the CLI](https://docs.emdashcms.com/deployment/core-migrations/#apply-large-content-migrations-from-the-cli). When it reports a held migration lock, follow [Release a stuck migration lock](https://docs.emdashcms.com/deployment/core-migrations/#release-a-stuck-migration-lock).
