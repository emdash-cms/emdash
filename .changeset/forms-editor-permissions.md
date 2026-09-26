---
"@emdash-cms/plugin-forms": patch
---

Fixes editors seeing "Failed to load forms" on the Forms page and "No forms yet" on the Submissions page while an admin on the same site sees every form. No route declared a `permission`, so all of them fell back to `plugins:manage`; the read routes (`forms/list`, `submissions/list`, `submissions/get`, `settings/turnstile-status`) now require `plugins:read`, which editors have. Writes and the export stay admin-only. When a role still cannot read forms, both pages and the Recent Submissions widget now say so instead of reporting an error or an empty list.
