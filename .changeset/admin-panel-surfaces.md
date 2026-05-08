---
"@emdash-cms/admin": patch
---

Fixes admin lists, tables and info cards rendering as transparent against the page background. Card containers in the content list, content type list, content type editor, media library, comments, users and device authorization views now have an explicit `bg-kumo-base` surface so they're visually distinct from the body.

Also fixes column header labels in content list tables ("Title", "Status", etc.) rendering pale because of an undefined Tailwind class (`text-kumo-fg`) -- they now use the default text color and rely on the sort indicator icon to signal active state.
