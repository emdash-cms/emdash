---
"emdash": minor
---

Adds deployment-managed core migrations, giving production deployments an explicit build, migrate, deploy, and verify workflow. Each Astro build writes a validated, secret-free manifest containing its exact EmDash version, ordered migration set, locale configuration, and database adapter. `emdash migrate` resolves and fingerprints the target, reports pending or unknown migrations, applies only the build's known migration set, and checks the deployed schema.

SQLite, libSQL, PostgreSQL, D1, and Hyperdrive deployments are supported. Runtime `auto`, `check`, and `manual` modes let sites adopt the workflow gradually; existing sites continue applying migrations automatically by default.

Builds write the manifest to `.emdash/migrations.json`. EmDash templates ignore this generated file, and existing sites should add it to `.gitignore`.
