---
"@emdash-cms/admin": patch
---

Makes Enter work in admin confirmation dialogs. A confirmation for something you can undo, such as Publish now, Publish changes, Move to Trash or Restore this version, now opens with its confirm button focused, so pressing Enter confirms it. A confirmation for something permanent, such as Delete Permanently, opens with Cancel focused, so Enter closes the dialog without acting. Publishing now over a schedule and restoring a version over unsaved edits count as permanent.

The Publish and plugin Uninstall confirmations now stay open when you click outside them, like the other confirmations. Press Escape or Cancel to close them.
