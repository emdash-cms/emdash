---
"@emdash-cms/admin": patch
---

Fixes the error message shown when publishing, unpublishing, scheduling, unscheduling, or discarding changes fails without a server message, so it follows the admin language instead of staying in English. Most other admin requests that fail without a server message also no longer append an English HTTP status text such as "Internal Server Error" to their error message.
