---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds an **Email users** action to **Settings > General** that tells every other active user where the site now lives. Each user gets an email with a button to the sign-in page at the configured `siteUrl`, or the **Site URL** when none is set, and a note that passkeys from the old address don't work there. The email does not sign anyone in. The action needs an email provider, passkey sign-in, and the `users:manage` permission, and shows how many emails were sent and how many the provider rejected.

The emails come from the new `POST /_emdash/api/settings/domain/notify` endpoint. It accepts signed-in sessions only and can be used 3 times per hour per site.
