---
"@emdash-cms/admin": patch
---

Fixes **Publish**, **Unpublish**, **Schedule**, **Remove schedule** and **Change publication date** in the content editor when you open another entry before your unsaved edits finish saving. The action was sent for the entry you had moved to: Publish and Unpublish failed there, while a schedule or a publication date could change that other entry. Each action now applies to the entry you started it on.

Fixes saving an entry you move back to while **Publish** or **Unpublish** is still running on the previous one. Its next save went out without the check for changes made elsewhere, so it could overwrite another editor's changes without a warning.

Fixes **Discard changes** when you open another entry before the discard finishes. The editor also reset the entry you had moved to, replacing anything you had typed there since, and that entry's next save could fail with a conflict.

Fixes the entry you move to turning read-only with "You no longer hold this entry" when another editor's lock refuses a **Schedule**, **Change publication date** or **Discard changes** you started on the previous entry.
