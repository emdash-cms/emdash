---
"emdash": patch
---

Fixes enabling a disabled redirect that closes a redirect loop. Enabling it from the admin, the API, or a plugin now fails with a loop validation error, as creating or editing the same redirect already did, and the database rejects it for writers that bypass the API. Previously such an enable succeeded and the loop was only flagged with an admin warning, so automation that toggled a loop-closing redirect on will now receive a validation error instead. Loops that already exist on a site are unchanged and can still be disabled.
