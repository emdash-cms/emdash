---
"@emdash-cms/cloudflare": minor
---

New `cloudflareEmail()` plugin: production email provider via Cloudflare Email Sending

Deployments on Cloudflare Workers had no production email provider — only the
dev console stub — so magic-link login, invites and notifications failed with
"Email is not configured". `cloudflareEmail({ from, replyTo?, binding? })`
registers the exclusive `email:deliver` hook and delivers through a
`send_email` Worker binding. Add it to the emdash() plugins array, activate it
under Extensions, then select it under Settings → Email.
