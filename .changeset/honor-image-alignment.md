---
"emdash": patch
---

Honor image alignment from WordPress imports at render and in the editor, and surface display-size controls for migrated images.

The Gutenberg to Portable Text importer already captured image `alignment`, but it was dropped by the renderer and not editable. `Image.astro` now emits `emdash-image--align-*` classes (left/right float, center, wide/full), the admin editor threads `alignment` through the PortableText/TipTap serializer and image node and adds an alignment control that reflects in the node view, and the Display Size panel now shows for migrated images that carry only display dimensions.
