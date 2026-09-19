# Phase 5: Define schema and seed data

Build the collections, fields, taxonomies, menus, widget areas, settings, and representative content needed to exercise the port. Read [schema and seed](../../building-emdash-site/references/schema-and-seed.md) for the current schema, file locations, media and reference syntax, and validation rules.

## Model the source content

- Create fields for content the template actually renders or editors need to manage.
- Keep taxonomy names consistent between the seed and query calls.
- Preserve source identifiers when a later import or redirect needs them.
- Use realistic long, short, missing, and media-rich entries to exercise the design.
- Add redirects for legacy URLs only when the migration owns those URLs and the destination is known.

Use a seed for a new disposable site's initial schema and sample content. Do not treat a seed as a production backup, bidirectional synchronization mechanism, or replacement for an existing-site import plan.

## Choose assets lawfully

Use licensed or user-provided images selected during discovery. Record the source and license of reused or substitute assets. Match the reference aspect ratio and visual weight when substituting an image.

Reference local seed media with the current `$media` syntax from the canonical seed guide. Do not copy a remote demo image merely because the theme code is open source.

## Validate safely

Apply the seed to a disposable database and inspect the first-request logs. Fix validation errors at their source. Do not delete an existing database to force a re-seed unless the user has identified that exact database as disposable.
