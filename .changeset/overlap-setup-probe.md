---
"emdash": patch
---

Speeds up the first anonymous page views on each new server instance, such as a fresh Cloudflare Worker isolate, when migrations run automatically: the database setup check now runs at the same time as runtime startup instead of before it.

A temporary database error while EmDash checks which migrations have been applied (for example a lost D1 connection) no longer blocks runtime startup on that instance for 30 seconds; the next request tries again. Only a migration that actually fails, or a migration lock left behind by a stopped instance, still pauses retries.
