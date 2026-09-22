---
"@emdash-cms/plugin-forms": patch
---

Fixes a form's webhook silently doing nothing. The call was never awaited or handed to the runtime, so on Cloudflare Workers it could be dropped once the visitor's confirmation had been sent; it now runs through `after()`, which registers it with the host so it is guaranteed to finish. A response that is not a success is also logged now: `fetch` only rejects on a transport error, so a 4xx, a 5xx, and the sign-in page an authenticated endpoint redirects to were all treated as if the webhook had worked, leaving no trace anywhere. The redirect case is detected by comparing the final URL rather than `Response.redirected`, because plugin HTTP access follows redirects itself and always reports `redirected: false`.
