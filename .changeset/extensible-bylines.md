---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds custom fields to bylines. Sites can define site-specific byline metadata (Twitter handle, pronouns, company, localised job title, etc.) via the new `/byline-schema` admin screen.

Per-field `translatable` flag picks whether values are stored per-locale (one value per locale row in a `translation_group`) or shared across every locale variant of the same byline identity. Schema management is gated by `schema:manage`; value editing by `bylines:manage`.

`BylineSummary` gains an optional `customFields: Record<string, CustomFieldValue>` property. Existing object-literal consumers stay source-compatible because the property is optional and runtime always returns `{}` when no fields are registered.

Implements [#1174](https://github.com/emdash-cms/emdash/discussions/1174). Builds on the bylines-i18n foundation from [#1146](https://github.com/emdash-cms/emdash/pull/1146).
