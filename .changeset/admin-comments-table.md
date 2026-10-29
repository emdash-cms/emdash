---
"@emdash-cms/admin": patch
---

Updates the Comments inbox table in the admin to match the content list's look, and fits it on phones.

- The Author and Comment columns are now one Comment column, with each author's name and email above their comment. Clicking the author's name or the comment opens the comment's details. Approve stays on each row that can be approved, and Mark as spam, Trash, and, for admins, Delete permanently move into the row's "…" menu.
- On right-to-left pages, each author's name and comment keeps its own text direction, so an English comment's closing punctuation stays at its end.
- When the table is narrower than 42rem (672px), such as on phones and portrait tablets, the Content and Date columns fold away and show under the comment instead. When the table is narrower than 28rem (448px), such as on phones, the author's email is hidden too.
- The bar that appears when comments are selected matches the content list's: it wraps on narrow screens instead of running off the edge, has a Clear button, and disables its buttons while a moderation request is running. Its Delete button now asks for confirmation before permanently deleting the selected comments.

Browser tests that clicked a row's "Mark as spam", "Trash", or "Delete permanently" button need to open the "Actions for comment by {author}" menu first, where those are menu items with the same names. The row's Approve button keeps its name. The select-all checkbox is now named "Select all on this page", and the author's name is a button named after the author alone instead of one that also held their email. The "Author" column header is gone, so tests that locate a `columnheader` named "Author" need to change. The "Actions" column header is now visually hidden and keeps its accessible name.
