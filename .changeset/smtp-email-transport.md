---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds built-in email providers and a Settings → Email admin UI to configure them. The SMTP transport delivers through any standard SMTP server (Brevo relay, Office365, Fastmail, Amazon SES, self-hosted Postfix). Configure it with the `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`, `EMAIL_SMTP_USER`, and `EMAIL_SMTP_PASS` env vars, plus optional `EMAIL_SMTP_SECURE`, `EMAIL_SMTP_FROM`, `EMAIL_SMTP_FROM_NAME`, `EMAIL_SMTP_FROM_EMAIL`, and `EMAIL_SMTP_REPLY_TO`, or in the admin UI. Credentials saved in the admin are stored encrypted, which requires `EMDASH_ENCRYPTION_KEY`, and changes apply without a restart. Supports STARTTLS (port 587) and implicit TLS (port 465); port 25 is refused with a clear error. Works on Cloudflare Workers and Node. A Cloudflare Email provider using the native `send_email` binding is also available, configured in the admin UI or with `EMAIL_FROM_NAME`, `EMAIL_FROM_EMAIL`, and `EMAIL_REPLY_TO`, with a binding test button in the admin UI. The `cloudflareEmail()` plugin keeps working unchanged, and the provider dropdown now also lists installed email plugins.

#### Exclusive provider selection

A stored provider selection for an exclusive hook (email, search, comment moderation, and similar) is now kept when its provider is no longer registered, for example after the plugin is disabled or uninstalled. Previously the selection was deleted and another provider was auto-selected. Now the hook stays unselected until the provider is registered again or an administrator selects another one; comment moderation uses the built-in moderator, or a single other moderation plugin, in the meantime. If you disable or remove your email provider plugin, select a new provider under Settings → Email.

The new "None" option pins email delivery off until a provider is selected again. Sites with a single email plugin keep being auto-selected; the unconfigured built-ins never block that.
