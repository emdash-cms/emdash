---
"@emdash-cms/admin": patch
---

Fixes the OG Image field in the content editor's SEO panel showing its Change and × buttons outside the image when the image was narrower than the panel. The preview now fills the field with the 1.91:1 crop that most social sites use for link previews, whatever the image's size or shape, and puts Replace and Remove buttons in its top corner. The buttons appear on hover or keyboard focus, and stay visible on touch screens and when the image can't load. Adding or removing an image with the keyboard no longer loses focus.
