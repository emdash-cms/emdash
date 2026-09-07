---
"@emdash-cms/admin": patch
"emdash": patch
---

Fixes the editor image settings panel overflowing at narrow widths and aligns its fields, help, and actions with the standard editor sidebar.

Changing image alignment or text preserves the existing display size. Reset clears custom dimensions, constrained editor images retain their aspect ratio, floated images stay visible, and None and Center have distinct positions.

Preserves image alignment through the exported Portable Text converters. Image settings offer None, Left, Center, and Right; existing imported Wide and Full values and public theme hooks are retained.
