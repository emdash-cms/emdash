---
"emdash": minor
"@emdash-cms/cloudflare": patch
---

Fixes concurrent core migrations on Cloudflare D1 failing partway with errors such as `table "_plugin_storage" already exists`. `emdash migrate` and runtime migrations in `auto` mode take a migration lock in the D1 database. A second run waits up to 10 seconds: it succeeds without applying anything if the first run finishes in that time, and otherwise fails without applying migrations.

A run that stops before releasing the lock leaves it held, because it may have stopped partway through a migration. This happens when a CI job is cancelled during `emdash migrate`, when a Worker in `auto` mode stops during a runtime migration, or when a development server is stopped while it applies migrations. Until the lock is released, pending migrations do not run and a D1 site in `auto` mode fails to initialize EmDash. Once the lock is older than a minute, migration runs fail at once with the lock's time and id, and the runtime retries after its migration-failure backoff.

Adds `emdash migrate --release-lock <id>` to release such a lock. `emdash migrate --status` reports the lock and its id. After confirming that no migration is running, release the lock with that id:

```sh
pnpm emdash migrate --release-lock 1788264000000
```

Releasing the lock of a remote D1 database needs a build manifest and an API token with D1 Edit permission. A lock in the local D1 database of a development server is released with Wrangler. See [Release a stuck migration lock](https://docs.emdashcms.com/deployment/core-migrations/#release-a-stuck-migration-lock) for both procedures.
