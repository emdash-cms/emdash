---
"emdash": patch
---

Fixes `<Image>` from `emdash/ui` so images with a blurhash placeholder keep their focal point. The generated style previously omitted the separating semicolon between the placeholder background and `object-position`, which caused browsers to discard both declarations.
