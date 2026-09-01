---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds an optional dark mode counterpart to image fields, so editors can pick a second image that the site shows in dark color schemes.

Enable the slot per field with the `darkVariant` widget option (`"options": { "darkVariant": true }` in a seed file, or the **Dark mode variant** switch in the admin field editor). Editors then see **Add dark mode variant** below the selected image. The variant is stored inside the field value as `darkVariant`, in the same shape as the primary image.

The `Image` component from `emdash/ui` renders both images when a variant is present and shows the matching one with CSS: a `dark` or `light` class on `<html>` pins the scheme, otherwise `prefers-color-scheme` decides. Both images share the primary image's alt text and loading attributes, and an `id` you pass lands on the primary image while the variant gets it with a `--dark` suffix. Without `priority`, the hidden one stays lazy and is not fetched until the scheme changes; with `priority`, both images download. Sites with another theme convention can override the `.emdash-image--light` and `.emdash-image--dark` selectors; the [Dark Mode guide](https://docs.emdashcms.com/guides/dark-mode/) shows the rules. Fields without the option, and values without a variant, render exactly as before.
