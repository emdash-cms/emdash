---
"emdash": minor
---

Adds `emdash import wordpress`, which converts a WordPress WXR export into JSON files on disk, and fixes `emdash --version` and `emdash --help` reporting `v0.0.0` instead of the installed version.

Analyze the export first, review the generated `migration-config.json`, then convert the content:

```sh
npx emdash import wordpress export.xml
npx emdash import wordpress export.xml --execute
```

Converted entries, a redirect map, downloaded attachments, and a progress file are written to `./wordpress-import` unless you pass `--output-dir`. After an interruption, run the command again with `--resume` to skip entries and attachments that were already converted. `--skip-media` leaves attachments out, and `--dry-run` reports the files a step would write. The command does not write to an EmDash database; the admin importer remains the way to import WordPress content into a site.
