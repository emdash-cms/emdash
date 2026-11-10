---
"emdash": patch
---

Fixes `EmDashClient` so migration scripts can keep an entry's original dates: `create()` accepts `publishedAt` and `createdAt`, and `update()` and `publish()` accept `publishedAt`. The content API already accepted these fields for users with `content:publish_any`, but the client's types rejected them and `update()` and `publish()` did not send them.
