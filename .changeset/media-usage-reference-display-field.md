---
"emdash": patch
---

Fixes media usage tracking in collections that have a reference field named `title` or `name`, where saving an entry recorded none of the images and files it uses. Saving now records them.
