---
"@emdash-cms/blocks": patch
"@emdash-cms/admin": patch
---

Fixes `media_picker` subfields in native Portable Text plugin repeaters so Block Kit types and validation accept the fields that the editor renders. Selected media use the compact image card, local storage keys are URL-encoded, and each row continues to store a URL string.
