---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes gallery blocks seeded with `$media` showing empty images and losing their media on first edit. The `Gallery` component now renders these images, including galleries seeded with earlier versions, and the content editor previews them and keeps their media references, alt text, and dimensions when it saves. Seeding a gallery now stores each `$media` image as a regular gallery media reference. Galleries whose references an earlier autosave already stripped are not restored.
