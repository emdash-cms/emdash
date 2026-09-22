---
"emdash": patch
"@emdash-cms/admin": patch
---

Shows the permissions a CLI or agent is requesting on the admin device authorization page (`/_emdash/admin/device`) before you approve its code. The page lists the permissions that approval will grant, and separately lists any requested permissions your role does not allow. The Authorize button stays disabled until the code is confirmed valid and at least one requested permission can be granted.

A new authenticated `GET /_emdash/api/oauth/device/authorize?user_code=XXXX-XXXX` endpoint returns a pending code's `requestedScopes` and the `grantedScopes` an approval by the current user would receive. Unknown, already-used and expired codes return `INVALID_CODE` or `EXPIRED_CODE`.
