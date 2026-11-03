---
"emdash": minor
---

Adds a `formats` prop to the `Image` component from `emdash/ui`, so sites can serve modern image formats with a fallback.

List the formats in order of preference. With more than one entry, the component renders a `<picture>` element: the earlier entries become `<source>` elements and the last entry becomes the fallback `<img>`. Without `fallbackFormat`, a single entry renders one `<img>` in that format.

```astro
<Image image={post.data.featured_image} width={1200} height={675} formats={["avif", "webp"]} />
```

The optional `fallbackFormat` prop sets the format of the `<img>` and keeps every `formats` entry as a `<source>`. The `quality` prop applies to every format the component renders. `formats` only applies to images optimized by the site's image service; images from external media providers keep the provider's own URLs. Without `formats`, the output is unchanged.
