---
"@emdash-cms/admin": patch
---

Removes the sticky editor header from content / content-type / section / settings pages. The sticky implementation had transparency artifacts (backdrop-blur over varied content), layout fragility (negative margins canceling parent padding), z-index conflicts with the app bar, and ~85px of permanent vertical chrome. Each editor now renders a Save button at the bottom of the form so users can save without scrolling back to the top header. The distraction-free hover-overlay header in the content editor is preserved.
