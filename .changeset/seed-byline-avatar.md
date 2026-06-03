---
"emdash": patch
---

Seed files can now attach an avatar to a byline. `bylines[].avatar` takes a `storageKey` (plus optional `alt`, `filename`, `mimeType`, `width`, `height`) for a file that already exists in the configured storage; applying the seed creates a `media` row and links it to the byline via `avatarMediaId`. Unlike a content `$media` reference, nothing is downloaded or uploaded, which suits seeding bylines alongside a media migration.
