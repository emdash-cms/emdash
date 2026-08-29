---
"@emdash-cms/auth": patch
"@emdash-cms/auth-atproto": patch
"emdash": patch
---

Fixes disabled accounts being able to complete passkey, Magic Link, OAuth, external-auth, or Atmosphere sign-in. Rejected authentication no longer records passkey usage, syncs external-auth profile data, creates OAuth account links, accepts invites, or leaves rejected Atmosphere provider sessions behind.
