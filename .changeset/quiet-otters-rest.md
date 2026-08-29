---
"@emdash-cms/auth": patch
"@emdash-cms/auth-atproto": patch
"emdash": patch
---

Fixes disabled accounts being able to complete passkey, Magic Link, OAuth, Atmosphere, or OAuth device sign-in. Rejected authentication no longer records passkey or API token usage, syncs external-auth profile data, creates OAuth account links, accepts invites, or leaves rejected Atmosphere provider sessions behind.
