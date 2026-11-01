---
"@emdash-cms/admin": patch
---

Updates the Media Library's list view to match the content list's look, and fits it on phones.

- Each file's name is a button, so keyboard users can reach it with Tab and press Enter to open the file's details. Clicking anywhere else on the row still opens the details, and rows can still be dragged onto folders. The open file's row takes the table's selection color instead of a brand tint.
- When the table is narrower than 42rem (672px), such as on phones and portrait tablets, the Type, Size, and Alt text columns fold away and show under each file's name instead. Long filenames, file types, and folder names wrap or truncate instead of widening the table, and each folder row keeps its name and Edit button in view.

In list view, browser tests can find a file's name as a button named after the file, such as `getByRole("button", { name: "photo.jpg" })`. Rows keep their `data-media-draggable`, `data-media-folder-drop-target`, and `data-drop-active` attributes, and the folder controls keep their "Open folder {name}" and "Edit folder {name}" names. A file's type, size, and alt text status are now in the row twice, under its name and in their own columns, with one copy hidden at any width, so tests that look up that text need to scope it to a cell, such as `getByRole("cell", { name: "image/png" })`.
