---
"emdash": patch
---

Fixes the `Image` component from `emdash/ui` rejecting the `quality` prop during `astro check`. Quality now reaches both Astro image rendering paths and providers that support it, without leaking onto unoptimized `<img>` elements.

Fixes EmDash's internal-media transforms on Cloudflare serving the full-size original for Astro quality presets or fractional and out-of-range numbers. Presets `low`, `mid`, `high`, and `max` map to 25, 50, 80, and 100; finite numbers are rounded and clamped to 1–100.
