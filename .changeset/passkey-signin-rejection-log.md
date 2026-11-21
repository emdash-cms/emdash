---
"emdash": patch
---

Adds the reason a passkey sign-in failed to the server logs, as `[passkey] sign-in rejected: <code>`, for example `credential_not_found` for a passkey the site doesn't know or `invalid_origin` for a sign-in from an address the site doesn't accept. The login page still shows the same "Authentication failed" message.
