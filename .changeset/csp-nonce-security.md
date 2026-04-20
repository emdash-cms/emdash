---
"emdash": minor
---

Adds nonce-based Content-Security-Policy to all HTML responses, replacing `'unsafe-inline'` with per-request cryptographic nonces for real XSS protection. In dev mode, `'unsafe-inline'` is kept alongside nonces for Vite HMR compatibility.
