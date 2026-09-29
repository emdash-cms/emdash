---
"emdash": minor
---

Adds `locale` and `translationOf` to the `content:beforeSave` and `content:afterSave` hook events, for trusted and sandboxed plugins, so a hook can tell a new entry from a new translation of an existing one.

`locale` is the locale the entry is saved in: the resolved requested locale (or the default locale) on a create, and the stored entry's locale on an update. `translationOf` is the ID of the source entry when a create comes from the translation flow, and is absent otherwise. Both fields are optional; existing hooks are unaffected.
