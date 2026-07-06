---
"emdash": minor
"@emdash-cms/admin": minor
---

Fixes "Worker exceeded resource limits" when importing large WordPress sites on Cloudflare. The plugin import now runs as a sequence of small requests — content pages, then comments, then menus and site identity — with a live progress bar instead of an indefinite spinner, and media files upload in bounded batches. An interrupted import can safely be re-run: already-imported content is skipped and the import fast-forwards to where it stopped.
