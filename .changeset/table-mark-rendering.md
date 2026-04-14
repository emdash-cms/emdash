---
"emdash": patch
---

Fixes Table block to render inline marks (bold, italic, code, links, etc.) through the Portable Text pipeline instead of stripping them to plain text. Links are sanitized via `sanitizeHref()`. Table styles now use CSS custom properties with fallbacks.
