---
"emdash": major
"@emdash-cms/cloudflare": major
"@emdash-cms/sandbox-workerd": patch
"@emdash-cms/plugin-test": patch
---

Moves the `emdash` package subpaths that only EmDash itself loads under `emdash/internal/`. These paths are not public API: their exports can change or be removed in any release.

Sites that use `emdash()` in `astro.config.mjs` need no changes. The integration, the database, cache and media adapter helpers, and the first-party Cloudflare, workerd sandbox and plugin-test packages all load the new paths automatically.

The following subpaths are removed:

| Removed subpath                                  | Now loaded from                                           |
| ------------------------------------------------ | --------------------------------------------------------- |
| `emdash/routes/*`                                | `emdash/internal/routes/*`                                |
| `emdash/middleware/auth`                         | `emdash/internal/middleware/auth`                         |
| `emdash/middleware/redirect`                     | `emdash/internal/middleware/redirect`                     |
| `emdash/middleware/request-context`              | `emdash/internal/middleware/request-context`              |
| `emdash/middleware/setup`                        | `emdash/internal/middleware/setup`                        |
| `emdash/middleware/media-usage-write-fence`      | `emdash/internal/middleware/media-usage-write-fence`      |
| `emdash/image-endpoint`                          | `emdash/internal/image-endpoint`                          |
| `emdash/media/local-runtime`                     | `emdash/internal/media/local-runtime`                     |
| `emdash/object-cache/memory`                     | `emdash/internal/object-cache/memory`                     |
| `emdash/db/sqlite-migrations`                    | `emdash/internal/db/sqlite-migrations`                    |
| `emdash/db/libsql-migrations`                    | `emdash/internal/db/libsql-migrations`                    |
| `emdash/db/postgres-migrations`                  | `emdash/internal/db/postgres-migrations`                  |
| `emdash/database/migration-lock`                 | `emdash/internal/database/migration-lock`                 |
| `emdash/database/pg-migration-lock`              | `emdash/internal/database/pg-migration-lock`              |
| `emdash/plugins/host`                            | `emdash/internal/plugins/host`                            |
| `emdash/plugins/http-wire`                       | `emdash/internal/plugins/http-wire`                       |
| `emdash/plugins/adapt-sandbox-entry`             | `emdash/internal/plugins/adapt-sandbox-entry`             |
| `emdash/plugin-test-runtime`                     | `emdash/internal/plugin-test-runtime`                     |
| `emdash/testing/registry`                        | `emdash/internal/testing/registry`                        |

#### What should I do?

If your project or package imports one of the removed subpaths directly, replace the import with a public entrypoint:

- To configure a database, object cache or media provider, use `sqlite()`, `libsql()` or `postgres()` from `emdash/db`, `memoryCache()` from `emdash/astro`, or `localMedia()` from `emdash/media`, instead of writing their entrypoints by hand.
- To test a plugin, use `@emdash-cms/plugin-test` instead of `emdash/plugin-test-runtime`.
- To add request middleware, use `emdash/middleware` or the `middleware.outer` option.

Rebuild after upgrading. `emdash migrate` rejects a migration manifest written by an earlier EmDash version.
