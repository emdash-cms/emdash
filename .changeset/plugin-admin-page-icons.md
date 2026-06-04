---
"@emdash-cms/admin": patch
---

Honor the `icon` field on plugin `adminPages` in the sidebar nav.

Plugin admin pages declared via `adminPages: [{ path, label, icon }]` previously rendered with a hardcoded `PuzzlePiece` glyph — the `icon` field was accepted in the types but never read at runtime. The sidebar now resolves the icon name to its `@phosphor-icons/react` component: documented lucide-style names (`settings`, `chart`, `award`, …) are aliased to the right glyph, and any other name is matched against the full Phosphor set by converting it to PascalCase (e.g. `chart-bar` → `ChartBar`). The icon set is loaded lazily from a single code-split chunk on first use, so the admin's main bundle is unaffected. Unknown or omitted names continue to fall back to `PuzzlePiece`, so the change is purely additive.
