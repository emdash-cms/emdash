---
"emdash": patch
---

Fixes self-hosted videos and audio still playing from the old WordPress site after an import. The media files were uploaded and the rewrite reported no error, but a `core/video` or `core/audio` block kept the original URL, so the post broke once the old site went away. The URL rewrite now also covers these embeds, including one placed in a column by a media-and-text block.
