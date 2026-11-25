---
"emdash": patch
"@emdash-cms/auth": patch
---

Updates `POST /_emdash/api/auth/magic-link/send` and `POST /_emdash/api/auth/signup/request` to respond before looking up the account and sending the email, so the response time is the same for every address and no longer depends on the email provider's speed. Delivery errors are still logged on the server.

`sendMagicLink()` and `requestSignup()` from `@emdash-cms/auth` no longer pause for 100-250 ms when there is nothing to send. If you call them from your own public endpoint and want its response time not to depend on whether an account exists, run them after responding (for example with `after()` from `emdash`) instead of awaiting them.
