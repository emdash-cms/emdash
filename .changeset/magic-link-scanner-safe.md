---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes magic link and account recovery emails failing for recipients whose mail is scanned (for example by Microsoft 365 Safe Links). Opening the link now shows a confirmation page in the admin, and the one-time link is only used when the recipient presses Continue, so a scanner that fetches the link no longer uses it up or receives the session. Links in emails sent before the upgrade keep working.

`GET /_emdash/api/auth/magic-link/verify` no longer signs in; it redirects to the confirmation page. Scripts that signed in by requesting that URL must now send `POST /_emdash/api/auth/magic-link/verify` with a JSON body `{ "token": "..." }` and the `X-EmDash-Request: 1` header, then keep the returned session cookie.
