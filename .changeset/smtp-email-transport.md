---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds built-in SMTP and Cloudflare Email providers, configurable under Settings → Email.

#### SMTP

The SMTP provider delivers through any standard SMTP server, such as Brevo, Office365, Fastmail, Amazon SES or a self-hosted Postfix, on Cloudflare Workers and Node. Configure it under Settings → Email or with environment variables:

- Required: `EMAIL_SMTP_HOST`, `EMAIL_SMTP_USER` and `EMAIL_SMTP_PASS`.
- Optional: `EMAIL_SMTP_PORT` (587 when empty), `EMAIL_SMTP_SECURE`, `EMAIL_SMTP_FROM`, `EMAIL_SMTP_FROM_NAME`, `EMAIL_SMTP_FROM_EMAIL` and `EMAIL_SMTP_REPLY_TO`.

Settings saved in the admin take precedence over environment variables and apply without a restart. Saving the password requires `EMDASH_ENCRYPTION_KEY`, which encrypts it in the database. Port 465 uses implicit TLS and port 587 uses STARTTLS. Port 25 and values that are not port numbers are refused.

#### Cloudflare Email

The Cloudflare Email provider sends through the Worker's `send_email` binding. Configure the sender under Settings → Email or with `EMAIL_FROM_NAME`, `EMAIL_FROM_EMAIL` and `EMAIL_REPLY_TO`. Settings → Email can check that the binding is reachable. The `cloudflareEmail()` plugin from `@emdash-cms/cloudflare` keeps working unchanged.

#### Choosing a provider

Settings → Email now has a provider dropdown that lists the built-in providers and any installed email plugins. Selecting "None" turns email delivery off until another provider is selected. A site with a single email plugin still selects it automatically, and a built-in provider is selected automatically only when its environment variables are set and no other provider is installed. `GET /_emdash/api/settings/email` reports the SMTP and Cloudflare Email settings, `PUT /_emdash/api/settings/email` saves them together with the selected provider, and `POST /_emdash/api/settings/email/test-binding` checks the Cloudflare binding.

#### Exclusive provider selection

A stored provider selection for an exclusive hook such as `email:deliver`, search or comment moderation is now kept when its provider is no longer registered, for example after the plugin is disabled or uninstalled. Previously the selection was deleted and the remaining provider was selected automatically.

Now the hook stays unselected until that provider is registered again or an administrator selects another one. Comment moderation uses the built-in moderator, or the only other moderation plugin, in the meantime. If you replace your email plugin, select the new provider under Settings → Email. For other exclusive hooks, select the new provider with `PUT /_emdash/api/admin/hooks/exclusive/<hook name>`.
