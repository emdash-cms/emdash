---
"@emdash-cms/plugin-forms": patch
---

Fixes two saves of the same form undoing each other's changes. A form update now leaves any field it does not send unchanged, instead of writing back the value it read at the start of the request. Saving a form in the editor no longer sets a form that was just paused from the forms list back to active, and pausing a form no longer reverts edits saved in the editor at the same moment.
