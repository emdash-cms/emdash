---
"emdash": patch
---

Fixes `entry.id` sometimes missing the locale prefix on multilingual sites. With several locales configured, entries in a locale whose URLs are prefixed get an `entry.id` such as `en/my-post`. With a Cloudflare database (D1, Durable Object SQL or Hyperdrive), in production and in `astro dev`, the prefix could be missing, depending on what else had already run in the same isolate, so the same entry returned `my-post` on some requests and `en/my-post` on others. Collection queries, `getEmDashEntry()` and referenced entries now always include the prefix.

If your templates add the locale to links themselves, for example `/en/posts/${entry.id}`, or pass `entry.id` to `getEmDashEntry()`, use `entry.data.slug` instead, which never includes the locale.
