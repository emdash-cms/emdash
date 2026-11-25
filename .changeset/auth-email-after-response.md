---
"emdash": patch
---

Updates `POST /_emdash/api/auth/magic-link/send` and `POST /_emdash/api/auth/signup/request` to respond before looking up the account and sending the email, so the response time is the same for every address and no longer depends on the email provider's speed. This applies on Cloudflare, `@astrojs/node`, Vercel and Netlify, and on sites whose own middleware sets `locals.waitUntil`. On other hosts the email is still sent before responding, as before. Delivery errors are still logged on the server.
