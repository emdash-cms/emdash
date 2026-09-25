---
"emdash": patch
---

Fixes admin sign-in silently returning to the login page when no Astro session driver is configured. Signing in with a passkey, magic link, invite link, or signup link now fails with a `SESSION_UNAVAILABLE` error explaining that a session driver is required, and OAuth sign-in returns to the login page with the same explanation, instead of reporting success without keeping the user signed in. Magic links, invite links, and signup links stay usable for a retry. `astro dev` and `astro build` also warn when the driver is missing or sessions are disabled with `session: false`. The Node, Cloudflare, and Netlify adapters configure a driver automatically; on other adapters, such as Vercel, configure `session.driver` in `astro.config.mjs`.
