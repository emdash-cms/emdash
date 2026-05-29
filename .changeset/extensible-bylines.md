---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds custom fields to bylines. Sites can define site-specific byline metadata (Twitter handle, pronouns, company, localised job title, etc.) via the new `/byline-schema` admin screen, accessed from the **Byline schema** link button at the top of the Bylines admin page (admin-only).

Per-field `translatable` flag picks whether values are stored per-locale (one value per locale row in a `translation_group`) or shared across every locale variant of the same byline identity. Schema management is gated by `schema:manage`; value editing by `bylines:manage`.

Custom-field values can be set at both create and update time. `POST` and `PUT` on `/_emdash/api/admin/bylines` accept the same `customFields` map; validation runs before any row write so a bad value (unknown slug, type mismatch, select-choice miss) returns 400 `VALIDATION_ERROR` without leaving partial state behind. In the admin, registered fields render inline with Name, Bio, etc. — no separate section header — and are available in the **New byline** dialog as well as edit.

`BylineSummary` gains an optional `customFields: Record<string, CustomFieldValue>` property. Existing object-literal consumers stay source-compatible because the property is optional and runtime always returns `{}` when no fields are registered.

Implements [#1174](https://github.com/emdash-cms/emdash/discussions/1174). Builds on the bylines-i18n foundation from [#1146](https://github.com/emdash-cms/emdash/pull/1146).
