---
"emdash": patch
"create-emdash": patch
---

Fixes autosave validation errors on content seeded from the blog,
portfolio, and starter templates (issue #867).

Two related issues:

- `_key` was strictly required on Portable Text blocks by the
  generated Zod schema, but the rest of the block schema is
  `.passthrough()` and the editor regenerates `_key` on every change,
  so requiring it on input rejected legitimate seed/import data
  without protecting any real invariant. `_key` is now optional in the
  validator.
- The portfolio template shipped `featured_image` as bare URL strings.
  `image` fields validate as `{ id, ... }` objects, so any user who
  edited a different field on a portfolio entry hit
  `featured_image: expected object, received string`. The portfolio
  seeds now use `$media` references in the same shape as the blog
  template, and every shipped template seed has stable `_key`s on its
  Portable Text nodes.

A regression test runs every shipped template seed through the same
validator the autosave endpoint uses, so future template changes that
break this invariant fail before release.
