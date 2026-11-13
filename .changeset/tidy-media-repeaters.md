---
"@emdash-cms/blocks": patch
"@emdash-cms/admin": patch
---

Fixes `media_picker` subfields in native plugin Portable Text repeaters, so Block Kit types and validation accept the fields that the editor already renders. Each row still stores the selected asset's URL string.

Updates `media_picker` in plugin Portable Text block forms and plugin field widgets to show the selected image in a compact card with visible Replace and Remove buttons. The card labels uploaded media as "Selected image" instead of showing its generated storage key, and the picker URL-encodes local storage keys so keys with spaces or reserved URL characters resolve.
