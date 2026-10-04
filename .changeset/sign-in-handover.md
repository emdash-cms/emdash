---
"emdash": minor
"@emdash-cms/admin": minor
"@emdash-cms/auth": minor
---

Adds a **Continue on** button to **Settings > General** after a site moves to a new domain. Passkeys only work at the address where they were created, so a user signed in at the old address can select the button to sign in at the new one without email. The single-use link expires after 5 minutes and opens **Settings > Security**, ready to add a passkey for the new address. The button appears when you are signed in at an address other than the **Site URL**, or the configured `siteUrl` when one is set. It is not shown when an external provider such as Cloudflare Access handles sign-in.

The link comes from the new `POST /_emdash/api/auth/handover` endpoint, which accepts signed-in sessions only and allows 5 links per user every 5 minutes. `GET /_emdash/api/settings/domain` now also returns `siteOrigin`, the address the link points to.

`@emdash-cms/auth` exports `createMagicLinkUrl()`, which creates a single-use sign-in link without sending an email.
