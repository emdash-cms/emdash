---
"emdash": minor
---

Adds relations, and makes `reference` fields entry pickers that link through them. A relation joins two collections under a site-unique slug, with a label and an optional link limit for each side; a reference field shows one side of it. An entry's selection is shared by all its translations, and on collections with revisions it goes live when the entry is published. Send selections under `references` on entry create and update, keyed by field slug. To render them, pass the field slugs in the `references` option of `getEmDashEntry`, and use `getEmDashReferences` to page past the first 50. `emdash types` generates a `{Collection}References` interface, seeds accept a top-level `relations` array, and `emdash export-seed --with-content` exports each entry's links. See the [Relations guide](https://docs.emdashcms.com/guides/relations/).

Upgrading changes existing data and APIs:

- A reference field that names a target collection becomes a picker and keeps its entries. Fields with no target, fields marked searchable or indexed, and fields whose locales select different entries keep working as before; convert them by hand under Content Types.
- Relations are no longer translated. A relation with different labels per locale keeps one set of labels. The relations API uses `slug` instead of `name`, requires `parentCollection` and `childCollection` on create, and no longer accepts `locale` or `translationOf`. `GET /_emdash/api/relations/:id/translations` is removed, and `GET /_emdash/api/relations` takes `collection` instead of `locale`.
- `POST /_emdash/api/content/:collection/:id/references/:relation/children` is removed. Write selections through `references` on the content create and update routes instead.
- `relations` is now a reserved collection slug. An existing collection with that slug keeps its content and API, but the admin no longer opens it.

See [Reference fields bind to relations](https://docs.emdashcms.com/deployment/updating/#changed-reference-fields-bind-to-relations) for how existing fields are converted.
