---
"@emdash-cms/registry-cli": patch
---

Improves `login` error reporting for OAuth response failures. Previously, transient PDS errors surfaced as a bare `unknown_error` with a stack trace; the CLI now prints the HTTP status, endpoint, OAuth error code/description, a body snippet when the response wasn't OAuth-shaped JSON, and a hint to retry on 5xx responses.
