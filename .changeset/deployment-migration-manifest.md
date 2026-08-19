---
"emdash": minor
---

Adds deployment-managed core migrations, allowing a deployment pipeline to apply the build's exact database migrations before new application code receives traffic. Astro builds write `.emdash/migrations.json`, which `emdash migrate` uses to inspect the target, apply pending migrations, and verify the deployed schema. Existing sites keep automatic runtime migrations by default.

Sites created from EmDash templates ignore generated migration manifests. Existing sites should add `.emdash/migrations.json` to `.gitignore`.
