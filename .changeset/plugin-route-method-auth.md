---
"emdash": patch
---

Fixes a privilege escalation on private plugin API routes: an editor (or a cross-origin page) could invoke admin-only, state-changing plugin routes by sending them as `GET` or `HEAD` instead of `POST`, which bypassed the permission tier and CSRF check. Every private plugin route now requires `plugins:manage` and the CSRF header regardless of HTTP method.
