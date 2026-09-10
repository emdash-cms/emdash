---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds built-in email providers and a Settings → Email admin UI to configure them. The SMTP transport delivers through any standard SMTP server (Brevo relay, Office365, Fastmail, Amazon SES, self-hosted Postfix) — configure via `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`, `EMAIL_SMTP_USER`, `EMAIL_SMTP_PASS`, and optional `EMAIL_SMTP_FROM` env vars, or in the admin UI (credentials stored encrypted; changes apply without a restart). Supports STARTTLS (port 587) and implicit TLS (port 465); port 25 is refused with a clear error. Works on Cloudflare Workers and Node. A Cloudflare Email provider using the native `send_email` binding is also available, with a binding test button in the admin UI.

Exclusive provider selection (email, search, and similar hooks) changes in two ways: a stored selection whose provider is temporarily unregistered is now preserved instead of silently reverting to another provider, and the new "None" option pins email delivery off until a provider is selected again. Sites with a single email plugin keep being auto-selected; the unconfigured built-ins never block that.
