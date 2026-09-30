---
"@emdash-cms/admin": patch
---

Fixes media uploads so supported video files (.mp4, .webm, .mov) report width and height, and prevents the Media Library details panel from truncating the Uploaded date when dimensions are absent.

Videos now have their display dimensions extracted via the browser's `<video>` element and sent through both the direct upload form and the signed-URL confirmation payload, so the detail panel can show a Dimensions row for them just like images. Audio and other non-dimensional files continue to omit dimensions cleanly.

The details grid also keeps the Uploaded row in the wider left column when no dimensions row is present, so the full upload date remains readable.
