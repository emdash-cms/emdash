---
"emdash": patch
---

Fixes Portable Text type exports from `emdash/ui` so TypeScript consumers can resolve the types and reject invalid values such as a number assigned to `PortableTextBlock`.

The `<PortableText>` component's props are now type-checked too, so invalid `value`, `components`, or `listNestingMode` arguments may report errors after upgrading. Undefined content remains supported and renders as empty content.
