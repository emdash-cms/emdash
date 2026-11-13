---
"emdash": patch
---

Fixes the blurred placeholder of `Image`, Portable Text images and `Gallery` from `emdash/ui`, which browsers ignored as invalid CSS, so images with a blurhash showed an empty box until they loaded. They now show the blurred preview while loading.
