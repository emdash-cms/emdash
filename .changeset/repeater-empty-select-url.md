---
"@emdash-cms/admin": patch
---

Fixes saving content when an optional select or URL sub-field in a repeater row is left empty or cleared. The save failed with "… has a value that is not one of its options." or "… must be a valid URL."

#### What should I do?

An entry with a repeater row that was saved empty before this release can still fail with these messages. Fill in that sub-field, or fill it in and clear it again, then save.
