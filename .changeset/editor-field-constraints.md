---
"@emdash-cms/admin": minor
"emdash": minor
---

Adds the field constraints declared in a collection schema to the content editor, so authors see a limit before a save can fail on it.

Text fields with `maxLength` show a live character count below the input and stop accepting input at the limit; a `minLength` is shown as a hint. Number fields with `min` or `max` show the allowed range and set it on the input. Content that is outside its bounds, such as text saved before a limit was lowered, is marked in the editor before a save is attempted.

The admin manifest now carries a field's `validation` object for every field type. Previously only repeater, file and image fields exposed it, so length and range rules never reached the editor. Plugin field widgets for trusted plugins receive the same `validation` object as a prop, so a custom widget can enforce the limits without hardcoding them.
