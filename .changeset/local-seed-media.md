---
"emdash": minor
---

Adds `$media.file` to seed files so local images can be imported without serving them over HTTP or disabling URL SSRF protection. Use `{ "$media": { "file": "assets/photo.jpg" } }` with an image next to the seed at `assets/photo.jpg`.

The CLI and Astro setup resolve files relative to the selected seed file's directory. Programmatic callers must supply `mediaBasePath` and a storage adapter. Supply exactly one non-null `url` or `file`; null values are treated as absent, and references that supply both sources are skipped. File paths must stay within that directory, including symlink targets. Local files require a Node.js filesystem at seed-apply time and are not bundled for deployment; Astro setup requires the seed directory at its build-time path. `skipMediaDownload` skips local files rather than creating external URLs for them.
