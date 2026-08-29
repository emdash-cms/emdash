---
"@emdash-cms/admin": patch
"emdash": patch
---

Updates account creation and modification times, passkey registration times, OAuth connection times, and API token creation and expiry times to include seconds and the viewer's time zone. Account updates containing at least one field now refresh the modification time, while empty updates preserve it.
