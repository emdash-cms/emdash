---
"@emdash-cms/auth": minor
---

Fixes a magic link or recovery link signing in twice when the same link is submitted by two requests at the same time, which created two separate sessions from one single-use link. Only one of the concurrent requests now succeeds; the other gets the "Invalid or expired link" error. Completing a signup or invite with a link that another request is already using now also fails with the invalid-link error instead of a server error. Custom `AuthAdapter` implementations must add the new `consumeToken(hash, type)` method, which atomically deletes and returns the matching token, or returns `null` when none exists.
