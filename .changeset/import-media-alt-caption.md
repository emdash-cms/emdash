---
"emdash": patch
---

Fixes WordPress imports dropping the alt text and caption of every media item. Media imported from a WXR file or through the EmDash Exporter now keeps the alt text and caption set in the WordPress media library. Media imported before this release keeps its empty alt text and caption, even if you rerun the media step, because the import reuses files it has already stored; add them in the media library. `parseWxr()` and `parseWxrString()` return each attachment's caption as `caption`, and `parseWxrString()` now fills each attachment's `meta`, as `parseWxr()` already did.
