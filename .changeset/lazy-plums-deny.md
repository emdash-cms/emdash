---
"@emdash-cms/admin": patch
---

Fixes the content editor toolbar on mobile with a four-column action grid that keeps actions visible without horizontal scrolling. Removes the persistent visible Saved label and shows save failures in a dismissible banner beneath the header at all widths. Preserves screen-reader save announcements and keeps explicit draft checkpoints available in Settings. Tablet and desktop retain their horizontal action layout, and error toasts remain available when the header has scrolled out of view.
