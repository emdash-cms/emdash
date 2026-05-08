---
"@emdash-cms/admin": patch
---

Replaces raw `<select>` and `<input type="search">` elements across the admin UI with Kumo's `Select` and `Input` components. This gives consistent styling, proper focus rings, accessibility (label association via the Field wrapper), and dark-mode handling for free instead of relying on hand-rolled Tailwind classes that bypassed the design system.
