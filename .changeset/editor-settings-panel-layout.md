---
"@emdash-cms/admin": minor
---

Redesigns the content editor layout. The editor now fills the viewport with a distraction-lighter writing column, and all publish controls live in a structural settings panel on the end side: a single Save control that reads out save and autosave progress, briefly confirms completion with Saved, then settles back to Save, plus Publish, Preview, and publish-state badges, sit in an action bar pinned above the panel's sections (slug, scheduling, ownership, bylines, translations, taxonomies, SEO, outline, revisions), with Move to Trash isolated at the bottom. Below the `lg` breakpoint the panel becomes a slide-in sheet behind a Settings button, while the Save control stays visible in the editor header. The layout mirrors correctly in RTL locales.
