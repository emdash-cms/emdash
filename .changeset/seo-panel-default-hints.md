---
"@emdash-cms/admin": patch
---

Shows the derived title and description as placeholders in the SEO panel. `getSeoMeta` already falls back to an entry's own `data.title` and `data.excerpt` when the panel is empty, but the panel gave no sign of it, so empty inputs read as "unset". Editors either retyped the page title into the SEO title or concluded the page had no SEO at all. The SEO Title and Meta Description fields now show the value that will actually be used, so an empty field reads as inheriting it. No change to the generated meta.
