---
"@emdash-cms/admin": patch
"emdash": patch
---

Updates account creation and modification times, passkey registration times, OAuth connection times, and API token creation and expiry times to include seconds and the viewer's time zone. User changes made through `UserRepository` now also refresh the account modification time.
