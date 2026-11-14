---
"emdash": patch
---

Fixes the blurred placeholder of `Image`, Portable Text images and `Gallery` from `emdash/ui`, which browsers ignored as invalid CSS, so images with a blurhash showed an empty box until they loaded. They now show the blurred preview while loading, positioned like the image.

Transparent images uploaded before EmDash 1.5.0 can still have a stored blurhash, which now shows through their transparent areas. Pass `placeholder={false}` to `Image`, or to `PTImage` and `Gallery` in a custom Portable Text component, as described in [Render an image in a template](https://docs.emdashcms.com/guides/media-library/#render-an-image-in-a-template).
