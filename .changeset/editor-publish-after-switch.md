---
"@emdash-cms/admin": patch
---

Fixes **Publish**, **Unpublish**, **Schedule**, **Remove schedule** and **Change publication date** in the content editor when you open another entry before your unsaved edits finish saving. The action was sent for the entry you had moved to: Publish and Unpublish failed there, while a schedule or a publication date could change that other entry. Each action now applies to the entry you started it on.
