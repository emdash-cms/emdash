---
"emdash": minor
---

Adds a built-in SMTP email transport for generic SMTP credentials (Brevo relay, Office365, Fastmail, Amazon SES, self-hosted Postfix). Configure via `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`, `EMAIL_SMTP_USER`, `EMAIL_SMTP_PASS`, and optional `EMAIL_SMTP_FROM` env vars. Supports STARTTLS (port 587) and implicit TLS (port 465); port 25 is refused with a clear error because Cloudflare blocks it. Works on Cloudflare Workers (via `cloudflare:sockets`) and Node (via `node:net`/`node:tls`). Sandboxed plugins cannot open TCP sockets, so this lives in core — explicitly selected plugin transports still take precedence.
