---
"emdash": patch
---

Speeds up the first public page view on each new server instance, such as a fresh Cloudflare Worker isolate: the database setup check now runs alongside runtime startup instead of before it, saving one database round trip.
