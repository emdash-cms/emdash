---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds per-field allowed MIME types for `file` and `image` fields. Field-level `allowedTypes` is now honored end-to-end: it filters the media picker, widens upload acceptance for that field (so e.g. a zip-only field can accept zip uploads even though the global allowlist excludes them), and validates referenced media against the destination field on content save. The schema editor in admin gains an "Allowed types" control with curated presets and freeform entry.

Behavior change: the `image` builder's `allowedTypes` option was previously accepted but read by nothing. It is now load-bearing — a code-first schema that already passed `allowedTypes` (e.g. `["image/png"]`) will now actually narrow the picker and gate uploads. Most users will see no change; if you set this option intending the old (silent) behavior, drop it.

Behavior change: updating a field via the admin schema editor now explicitly clears its validation when the form contains no validation settings, instead of leaving an existing `validation` value intact. This only affects fields with pre-existing validation that is not expressible in the editor UI.
