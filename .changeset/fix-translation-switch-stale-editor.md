---
"@emdash-cms/admin": patch
---

Fixes stale content shown in the Portable Text editor when switching between translations of the same content. Previously, navigating from one locale's editor to another (e.g. from the English version of a post to the French version) kept the previous locale's body in the editor, and any subsequent edit would silently overwrite the new translation's content. The form now resets synchronously when the underlying content item changes, and field editors are keyed by item id so they remount cleanly on a translation switch.
