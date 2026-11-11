---
"@emdash-cms/admin": patch
---

Fixes **Publish**, **Unpublish**, **Schedule**, **Remove schedule** and **Change publication date** in the content editor when you open another entry before your unsaved edits finish saving. The action was sent for the entry you had moved to: Publish and Unpublish failed there, while a schedule or a publication date could change that other entry. Each action now applies to the entry you started it on.

Fixes **Discard changes** when you open another entry before the discard finishes. The editor reloaded the entry you had moved to instead of the discarded one, replacing anything you had typed there since, and that entry's next save could fail with a conflict. The discarded entry could keep showing its old draft when you went back to it.

Fixes the entry you move to turning read-only with "You no longer hold this entry" when another editor's lock refuses a **Schedule**, **Change publication date** or **Discard changes** you started on the previous entry.
