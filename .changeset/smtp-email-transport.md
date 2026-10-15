---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds a built-in SMTP email provider. It delivers through any standard SMTP server, such as Brevo, Office 365, Fastmail, Amazon SES or a self-hosted Postfix, on Node and on Cloudflare Workers with the `nodejs_compat` flag.

#### Configure

Choose **SMTP** under Settings → Email, or set environment variables:

- Required: `EMAIL_SMTP_HOST`, `EMAIL_SMTP_USER` and `EMAIL_SMTP_PASS`.
- Optional: `EMAIL_SMTP_PORT` (587 when empty), `EMAIL_SMTP_SECURE`, `EMAIL_SMTP_FROM`, `EMAIL_SMTP_FROM_NAME`, `EMAIL_SMTP_FROM_EMAIL` and `EMAIL_SMTP_REPLY_TO`.

Settings saved in the admin take precedence over environment variables and apply without a restart. Saving them requires `EMDASH_ENCRYPTION_KEY`, which encrypts the password in the database. Changing the host or username requires entering the password again.

Port 465 uses implicit TLS and port 587 uses STARTTLS. The provider verifies the server certificate, never signs in before TLS is established, and signs in with `AUTH PLAIN` or `AUTH LOGIN`, whichever the server offers. Port 25 is refused. Invalid environment variables are ignored with a warning in the server log.

#### Provider selection

Settings → Email now has a provider dropdown that lists SMTP and any installed email plugins. When its environment variables are set, SMTP delivers email unless an email plugin is active or another provider is selected. Without them, SMTP is used only after you select it. A site with a single email plugin still selects that plugin automatically.

**Send test email** now shows the SMTP server's error, for example a rejected login, instead of a generic failure.

#### API

`GET /_emdash/api/settings/email` also reports the SMTP settings, without the password. The new `PUT /_emdash/api/settings/email` saves SMTP settings together with the selected provider, or selects a plugin provider. `PUT` with `{ "provider": "smtp" }` and no settings selects SMTP from its saved settings or environment variables. Sending a test email with `POST /_emdash/api/settings/email` returns SMTP delivery errors with status 502.
