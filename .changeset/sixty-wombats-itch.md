---
"@emdash-cms/admin": patch
---

Removes the sticky editor header from content / content-type / section / settings pages. The sticky implementation had transparency artifacts (backdrop-blur over varied content), layout fragility (negative margins canceling parent padding), z-index conflicts with the app bar, and ~85px of permanent vertical chrome. Save remains accessible via the in-form Save button at the bottom of the form and the standard Cmd+S keyboard shortcut, so the sticky behavior wasn't earning its visual cost. The distraction-free hover-overlay header in the content editor is preserved.
