# @emdash-cms/marketplace

Read-only Cloudflare Worker for the deprecated EmDash plugin marketplace at `marketplace.emdashcms.com`.

The marketplace no longer accepts sign-ins or new plugins. It keeps serving plugins that were already published, so existing EmDash sites with the `marketplace` option can still browse, install and update them. New plugins are [published to the plugin registry](https://docs.emdashcms.com/plugins/creating-plugins/publishing/). To move a site off the marketplace, see [Migrate from Marketplace](https://docs.emdashcms.com/plugins/migrate-from-marketplace/).

## Routes

The routes below are under `/api/v1` and support `GET` and `HEAD`. `OPTIONS` is handled for CORS preflight. Any other request under `/api/*`, including `POST`, `PUT`, `PATCH`, `DELETE` and the removed sign-in and publishing routes, returns `410 Gone`.

| Route                                                 | Purpose                  |
| ----------------------------------------------------- | ------------------------ |
| `/plugins`                                            | Search and list plugins  |
| `/plugins/:id`                                        | Plugin detail            |
| `/plugins/:id/versions`                               | Version history          |
| `/plugins/:id/versions/:version/bundle`               | Bundle download          |
| `/plugins/:id/icon`, `/plugins/:id/versions/:v/icon`  | Plugin icons             |
| `/plugins/:id/versions/:version/screenshots/:file`    | Plugin screenshots       |
| `/themes`, `/themes/:id`                              | Theme listing and detail |
| `/themes/:id/thumbnail`, `/themes/:id/screenshots/:f` | Theme images             |

The Worker reads from the `DB` (D1) and `R2` bindings and uses the `IMAGES` binding to resize images. `src/db/schema.sql` documents the existing database schema.

## Development

```bash
pnpm dev        # starts wrangler dev server on :8787
pnpm test       # runs vitest
```
