---
"emdash": patch
---

Fixes Portable Text type exports from `emdash/ui` so TypeScript consumers can resolve the types and reject invalid values such as a number assigned to `PortableTextBlock`.
