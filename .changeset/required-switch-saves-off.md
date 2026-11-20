---
"@emdash-cms/admin": patch
---

Fixes saving content when a required Boolean field's switch is left off. Saving a new entry failed with an error such as "Featured is required." until the switch was turned on and back off. An entry whose repeater rows were saved before a required Boolean sub-field was added could not be saved, autosaved, or translated. New entries now save `false` for every Boolean field that is left off. Existing entries, and translations created from them, save `false` for each required Boolean field or sub-field that has no stored value.
