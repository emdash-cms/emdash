---
"emdash": patch
---

Speeds up the first anonymous page views on each new server instance, such as a fresh Cloudflare Worker isolate, when migrations run automatically: the database setup check now runs at the same time as runtime startup instead of before it.

When all migrations are already applied, a temporary database error during the startup migration check (for example a lost D1 connection) no longer blocks runtime startup on that instance for 30 seconds; the next request tries again. An error while pending migrations are being applied, or a migration lock left behind by a stopped instance, still pauses retries.
