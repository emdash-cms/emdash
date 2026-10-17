---
"emdash": patch
---

Fixes the `Image` component from `emdash/ui` rejecting the `quality` prop during `astro check`. Numeric quality values and Astro image-service presets now typecheck without a spread-prop workaround.
