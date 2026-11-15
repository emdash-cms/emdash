---
"@emdash-cms/cloudflare": minor
---

Adds `runScheduledTasks()` to `@emdash-cms/cloudflare/worker`. It runs scheduled publishing and maintenance and purges the route cache for what it publishes.

Workers Cache purges made from `scheduled()` report success but leave cached pages in place, so on sites that use `cacheCloudflare()`, scheduled publishing through `createScheduledHandler()` never updated cached pages. To fix this, call `runScheduledTasks()` from an RPC method on a `WorkerEntrypoint` default export and have `scheduled()` call that method through `ctx.exports.default`. See [Scheduled publishing with the Workers Cache](https://docs.emdashcms.com/deployment/route-caching/#scheduled-publishing-with-the-workers-cache). `createScheduledHandler()` behaves as before.
