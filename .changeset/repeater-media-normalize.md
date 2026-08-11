---
"emdash": patch
---

Normalize media values inside repeater image sub-fields. A bare media id posted via the REST API into a repeater sub-field is now normalized into a full `MediaValue` (the same treatment top-level image/file fields already get), instead of being stored verbatim and rendered as "Image not found" in the admin.
