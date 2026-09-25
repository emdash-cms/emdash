---
"emdash": patch
---

Fixes click-to-edit for text on the page in Edit mode:

- In the Playground, clicking an editable title or text field now edits it in place, and clicking an editable image opens the image picker. Previously these fields showed an outline on hover but did nothing when clicked.
- Multi-line text fields, such as excerpts, now edit in place when the page shows the field's stored text unchanged, and line breaks added while editing are saved. Previously, clicking a text field always opened the entry in the admin. It still does when the page shows the text transformed, for example Markdown rendered as HTML or a shortened excerpt, so an edit on the page can't overwrite the full stored text.
- Clicking an editable field inside a link, such as a title in a post card, edits the field instead of following the link, including when the field is clicked before the editor has finished loading.
