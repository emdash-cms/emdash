---
"emdash": minor
"@emdash-cms/admin": minor
"@emdash-cms/gutenberg-to-portable-text": patch
---

Adds optional `link` on portable-text image blocks: editor link buttons work on image selection, and `Image.astro` wraps images in a sanitized `<a>` when `link.href` is set. Legacy `link: "https://…"` strings written by WordPress/Gutenberg imports are normalised on read, so already-imported linked images keep their link and are upgraded to the object shape on their next edit.
