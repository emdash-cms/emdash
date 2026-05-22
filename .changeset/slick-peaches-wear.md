---
"@emdash-cms/plugin-cli": patch
---

Refactors the build pipeline's runtime validation of the probed plugin's
default export to use a Zod schema. Error messages keep the same format
(`hook "X" must be a function or { handler, ... }`, `hook "X" has
invalid FIELD VALUE (...)`). Exotic-object entries (Date, RegExp,
Promise, class instances) now produce the wrong-shape error instead of
falling through to a misleading "missing handler" error. BigInt /
cyclic-object / function / symbol field values are rendered safely in
error messages instead of crashing with a TypeError.
