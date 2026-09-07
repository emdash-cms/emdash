---
"@emdash-cms/admin": patch
"emdash": patch
---

Fixes the editor image settings panel overflowing at narrow widths and aligns its fields, help, and actions with the standard editor sidebar.

Changing image alignment or text preserves the existing display size. Reset clears custom dimensions, constrained editor images retain their aspect ratio, floated images stay visible, and None and Center have distinct positions.

Preserves image alignment through the exported Portable Text converters. Wide and Full are disabled for new selections in image settings; existing imported values and public theme hooks are retained.
