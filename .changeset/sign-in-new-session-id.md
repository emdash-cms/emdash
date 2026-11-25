---
"emdash": patch
"@emdash-cms/auth-atproto": patch
---

Fixes sign-in keeping the session ID the browser already had. Signing in with a passkey, magic link, OAuth, Atmosphere, an invite, signup, first-admin setup or external authentication now starts the session under a new ID and removes the previous one from the session store.
