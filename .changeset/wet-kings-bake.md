---
"emdash": minor
---

Adds Noto Sans as the default admin UI font via the Astro Font API. Fonts are downloaded from Google at build time and self-hosted. The base font covers Latin, Cyrillic, Greek, Devanagari, and Vietnamese. Additional scripts (Arabic, CJK, Hebrew, Thai, etc.) can be added via the new `fonts.scripts` config option. Set `fonts: false` to disable and use system fonts.
