---
"emdash": minor
---

Generates precise TypeScript types for repeater fields. Type generation emitted `unknown` for every repeater, so consuming code had to declare row shapes by hand and cast to them. It now emits an inline row type built from the field's sub-fields, with enumerated options for a `select` sub-field and the media object shape for an `image` sub-field. A sub-field that is not required is typed as nullable, matching what content validation accepts, and a repeater with no sub-fields still emits `unknown`.

Regenerate types after upgrading. Code that casts a repeater to a hand-written row type may now report errors where that type has drifted from the schema.
