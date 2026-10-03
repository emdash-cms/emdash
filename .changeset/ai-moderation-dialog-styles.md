---
"@emdash-cms/plugin-ai-moderation": patch
---

Fixes the "Edit Category" and "Add Category" dialogs on the AI Moderation settings page rendering without a background, drawn over the category list and unreadable. The dialog, its fields and the primary buttons now use the admin's Kumo design tokens instead of utility classes that the admin stylesheet does not ship.
