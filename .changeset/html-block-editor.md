---
"emdash": minor
"@emdash-cms/admin": minor
---

First-class HTML block in the admin editor. The existing `htmlBlock` Portable Text type (produced by the WordPress and Contentful importers) is now a fully editable block in the rich-text editor. Authors can insert an HTML block via the `/html` slash command, edit raw HTML in a textarea, and toggle a sanitized preview. Imported `htmlBlock` content that previously fell through to an opaque `pluginBlock` placeholder is now rendered in the same editable UI. The inline (visual-editing) editor preserves HTML blocks as read-only placeholders to prevent data loss.
