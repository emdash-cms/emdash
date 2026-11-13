---
"emdash": patch
---

Fixes the blurred placeholder of `Image`, Portable Text images and `Gallery` from `emdash/ui`, which browsers ignored as invalid CSS, so images with a blurhash showed an empty box until they loaded. They now show the blurred preview while loading.

Transparent images uploaded before EmDash stopped generating placeholders for them can still have a stored blurhash, which now shows through their transparent areas. Upload them again, or pass `placeholder={false}` where you render them with `Image`.
