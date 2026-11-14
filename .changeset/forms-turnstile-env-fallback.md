---
"@emdash-cms/plugin-forms": patch
---

Turnstile keys can now come from the deployment environment. When a form's own `turnstileSecretKey` / `turnstileSiteKey` setting is empty, the plugin falls back to `process.env.TURNSTILE_SECRET` / `process.env.TURNSTILE_SITE_KEY`. A saved per-form setting still wins, so existing sites are unchanged. This lets an operator hosting many sites from one deployment configure Turnstile once, centrally, without the secret ever being copied into per-tenant form storage.
