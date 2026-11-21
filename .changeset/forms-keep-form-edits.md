---
"@emdash-cms/plugin-forms": patch
---

Fixes form edits being undone when someone submits the form while the edit is saved. Renaming a form, changing its fields or settings, or pausing it now sticks even if a submission arrives at the same moment, where before the form could silently revert, including back to accepting submissions. Submission counts also stay accurate when several submissions arrive together or a submission is deleted. Counts that were already wrong before this release are not corrected automatically.

The plugin now requires `emdash` 0.38.0 or later.
