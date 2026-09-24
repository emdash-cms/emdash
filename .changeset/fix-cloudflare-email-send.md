---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fix `cloudflareEmail()` silently failing to reach `binding.send()` on some Astro Cloudflare builds, and make email delivery errors visible in runtime logs.

- The provider now resolves `cloudflare:workers` `env` through a dedicated helper module (`cloudflare-email-env.ts`) so the Worker runtime evaluates it as a static import rather than a direct dynamic import of the built-in specifier. This avoids bundler/runtime paths where `import("cloudflare:workers")` inside the bundled Worker did not resolve.
- `EmailPipeline.send()` now `console.error`s the provider and recipient before re-throwing a delivery error, so failures are not lost when callers (e.g. magic-link routes) intentionally swallow the error to avoid leaking whether an account exists.

No configuration changes are required; existing `send_email` bindings continue to work.
