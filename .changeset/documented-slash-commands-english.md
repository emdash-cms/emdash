---
"@emdash-cms/admin": patch
---

Fixes the rich text editor's slash menu listing nothing for `/section`, `/video` or `/iframe` when the admin language translates the command's name, such as "Abschnitt" in German or "Vidéo" in French. These commands now match their English names in every admin language, as the guides describe.
