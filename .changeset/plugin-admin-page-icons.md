---
"@emdash-cms/admin": patch
---

Honor the `icon` field on plugin `adminPages` in the sidebar nav.

Plugin admin pages declared via `adminPages: [{ path, label, icon }]` previously rendered with a hardcoded `PuzzlePiece` glyph — the `icon` field was accepted in the types but never read at runtime. The sidebar now resolves the icon name to its `@phosphor-icons/react` component: common documented names (`settings`, `chart`, `history`, `image`, `trophy`, …) are statically mapped so they resolve synchronously, and any other name is matched against the full Phosphor set by converting it to PascalCase (e.g. `chart-bar` → `ChartBar`) and lazy-loading it from a code-split chunk. The full set is therefore reachable without bundling it into the admin's main chunk. Unknown or omitted names fall back to `PuzzlePiece`, so the change is purely additive.
