---
"emdash": minor
---

The `Image` component from `emdash/ui` accepts a `formats` prop to serve multiple output formats. With more than one format (for example `formats={["avif", "webp"]}`), the component renders a `<picture>` element: the last entry becomes the fallback `<img>` and the earlier entries become `<source>` elements in order. A single-entry `formats` renders one `<img>` in that format. An optional `fallbackFormat` prop overrides the format used for the `<img>`, keeping every `formats` entry as a `<source>`. Without `formats`, the component renders a single `<img>` in the image service's default format, as before.
