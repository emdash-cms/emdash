---
"@emdash-cms/sandbox-workerd": patch
---

Fixes sandboxed plugins being denied on the workerd runner when their manifest declares current capability names such as `content:read`, `media:write`, `users:read` or `network:request`. Manifests using older capability aliases keep working, and permission errors now name the current capability.
