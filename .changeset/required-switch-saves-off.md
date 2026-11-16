---
"@emdash-cms/admin": patch
---

Fixes saving content with a required on/off field left at Off. Saving a new entry failed with "<Field> is required." until the switch was turned on and back off. An entry whose repeater rows were saved before a required on/off sub-field was added could not be saved or translated. The editor now saves `false` for a required switch that shows Off.
