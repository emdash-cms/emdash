---
"@emdash-cms/auth": patch
"emdash": patch
---

Malformed invite, signup, and magic-link tokens now return a clean "invalid token" error instead of a 500. Token hashing tolerates values that aren't valid base64url, so an unrecognized token misses the lookup like any other unknown token.
