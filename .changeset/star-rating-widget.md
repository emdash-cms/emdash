---
"@emdash-cms/admin": minor
"emdash": minor
---

Adds a built-in `stars` widget for integer and number fields. Set a field's `widget` to `"stars"` to edit it as clickable stars instead of a number input, with `options.max` controlling how many stars show (default 5). Clicking a star sets the rating, clicking the current rating clears it. The stored value stays a plain integer, so themes read it without any extra runtime.
