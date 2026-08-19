---
"emdash": minor
---

Adds deployment-managed core migrations so production databases can be updated before a new version of the site starts serving traffic.

To adopt the workflow, build the site, inspect and apply its migrations with `emdash migrate`, deploy that same build, then run `emdash migrate --check` to verify the database. Existing sites continue applying migrations automatically by default; switch the runtime to `check` only after the deployment migration job is reliable.

Follow [Manage Core Database Migrations](https://docs.emdashcms.com/deployment/core-migrations/) for setup, credentials, target confirmation, CI configuration, and rollout guidance.
