---
"@emdash-cms/admin": patch
"@emdash-cms/blocks": patch
---

Updates the admin's confirmation, form and notice dialogs to Kumo's `LayerDialog` design. Each dialog keeps its title in a fixed header, scrolls its content in a card, and puts Cancel and the main action in a tray along the bottom. On phones, dialogs open as bottom sheets, and most can be swiped down to dismiss. Block Kit button confirmations on plugin admin pages use the same design.

Dialogs with Cancel and an action no longer show a separate close (×) button; Cancel, Escape and clicking outside behave as before. In the byline and media folder dialogs, Delete moves from the bottom bar to the end of the dialog's content. Creating a relationship from the field dialog opens it in a second dialog on top, whose Back button returns to the field. The media picker, media details, media upload, bulk tagging, content picker and section picker dialogs keep their previous design.

Browser tests that clicked a dialog's "Close" button should click "Cancel" or press Escape instead. A dialog now takes focus itself when it opens, unless one of its fields takes focus, so press Tab to reach its first control. The plugin permissions and uninstall dialogs are now named by their titles, such as "Plugin Permissions" and "Uninstall Gallery?", instead of "Capability consent" and "Uninstall confirmation".
