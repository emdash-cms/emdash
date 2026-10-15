---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fixes the `defaultRole` and `roleMapping` hover text for external auth providers and Cloudflare Access, which called role 30 "Editor" and role 40 "Developer". Role 30 is Author and can publish its own content, and role 40 is Editor. Only the descriptions and examples changed, not how roles resolve.

#### What should I do?

If you set `defaultRole` or a `roleMapping` entry to `30` because the hover text said Editor, check that Author access is what you meant. Use `20` (Contributor) for people who should not publish. The Access `defaultRole` still defaults to `30`.
