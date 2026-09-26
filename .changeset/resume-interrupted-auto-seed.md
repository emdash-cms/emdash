---
"emdash": patch
---

Fixes fresh Cloudflare D1 sites remaining partially initialized when the first-request seed is interrupted while creating a collection. The next request now resumes the seed, while attempts to create a collection over an orphaned content table return a specific conflict instead of a generic server error.
