---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fixes Hyperdrive sites answering logged-out requests with a 500 right after a deploy or scale-out. When several logged-out visitors reached a freshly started Worker at once, the requests shared one database connection, and Workers cancelled them with "The Workers runtime canceled this request because it detected that your Worker's code had hung". Nothing was logged. Every request now uses a database connection it opened itself. Sites on D1, or on Node.js with SQLite or PostgreSQL, were not affected.

With automatic migrations (the default), the first logged-out request on a new Worker or server also makes one fewer database query.
