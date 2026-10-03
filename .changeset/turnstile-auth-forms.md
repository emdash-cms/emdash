---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds an optional Cloudflare Turnstile check to the admin's email sign-in (magic link) and self-signup forms. Set `EMDASH_TURNSTILE_SITE_KEY` together with `EMDASH_TURNSTILE_SECRET_KEY` (or `TURNSTILE_SECRET_KEY`) to turn it on. Sites that set only the secret key, for comments, are unaffected.

When enabled:

- The admin shows the Turnstile widget on both forms. **Send magic link**, the signup **Continue** button, and **Resend email** stay disabled until the check completes. If a content blocker stops the widget from loading, the form says so.
- `POST /_emdash/api/auth/magic-link/send` and `POST /_emdash/api/auth/signup/request` reject requests without a valid `turnstileToken` in the body with `403 TURNSTILE_FAILED`. Scripts that call these endpoints directly must send one.
- `GET /_emdash/api/auth/mode` returns the site key as `turnstileSiteKey`, and the admin's Content Security Policy allows `https://challenges.cloudflare.com`.

Comments and sign-in share the secret key, so a site that already uses Turnstile for comments must use that widget's site key and add the admin hostname to the widget. If the keys don't match, the hostname is missing, or Turnstile is unreachable, email sign-in and signup fail while passkey sign-in keeps working. Remove `EMDASH_TURNSTILE_SITE_KEY` to turn the check off again.
