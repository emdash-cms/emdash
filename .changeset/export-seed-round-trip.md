---
"emdash": minor
---

Fixes `emdash export-seed` output so it survives `emdash seed` on a fresh database, and adds `--media-base-url` so exported media can be imported.

- Exports sections and redirect rules. Anything a seed cannot represent is left out with a warning on stderr: redirect rules with status 410 or 451, duplicate redirect sources kept from older databases, and imported sections whose slug contains characters other than lowercase letters, digits, and hyphens.
- Menu items that link to exported content now point at the restored entries instead of losing their link. `emdash seed` also restores links to entries in custom collections and collection archive links.
- Scheduled entries are exported as drafts instead of being published on import.
- Exports each collection's comments setting and its title and date fields, and whether each field is translatable. Seed fields accept `translatable`, and sections accept `source: "user"`.
- Exports file fields and image sub-fields of repeaters as `$media` references, as well as image fields.

`$media` URLs are site-relative by default, and `emdash seed` cannot download a relative URL, so those fields came back empty. Pass the source site's public URL to write absolute URLs:

```sh
npx emdash export-seed --with-content=all --media-base-url=https://example.com > seed.json
```

Without `--media-base-url`, the export warns when it writes relative media URLs. Images inside Portable Text fields are not converted and still refer to the source site's media.
