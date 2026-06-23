---
"emdash": patch
---

Byline avatar hydration now includes the media LQIP placeholder fields (#1457). Content byline credits already folded in the avatar's `avatarStorageKey` and `avatarAlt` via the media join, but dropped the `blurhash`/`dominant_color` placeholder columns, so author avatars couldn't render a low-quality image placeholder while loading even though the media stored one. `BylineSummary` now also carries `avatarBlurhash` and `avatarDominantColor`, populated by `getContentBylines`, `getContentBylinesMany`, and `findByUserIds` (and surfaced in the byline API response), so themes can paint a blurhash/dominant-colour placeholder for byline avatars exactly as they can for other media.
