---
"@emdash-cms/admin": patch
---

Fixes how admin dialogs handle mistakes, slow requests and stray clicks, so each dialog says what is wrong and typed input is not lost by accident.

In form dialogs, such as the field, relation, byline, menu, section, taxonomy, redirect, folder, domain and invite dialogs, the main action stays available instead of being disabled without a reason. Pressing it with missing or invalid input marks each field that needs attention with a message and moves focus to the first one, and each message clears as its field is corrected. The checks match what the server accepts, so most mistakes are caught before anything is sent, and a name or slug that is already taken is reported on its field in the admin's language. A new select field also needs at least one option, and a new blocks field at least one block type when the site has any, because editors could not fill in either field without them. Enter submits these dialogs, a double click sends one request, and a dialog with typed input no longer closes when you click outside it or swipe it down on a phone. Cancel and Escape still close it.

Confirmations that send a request, such as deleting a content type, field, comment or entry, discarding draft changes, replacing an image with its crop, or taking over an entry someone else is editing, now stay open while the request runs, show its progress, and show a failure inside the dialog instead of closing first. A failure shown in a dialog is no longer also reported in a toast, apart from a failed save of the entry's unsaved edits before scheduling or changing its publication date.

A few dialogs also behave more predictably:

- Adding a term whose name is already used under another parent suggests a free slug, such as `accessories-1`, instead of saving it under a different slug than the one shown.
- A file type typed into a media field's allowed types but not added is saved with the field.
- A plugin install that asks for more permissions lists them without reporting a failure.
- Deleting a redirect that was already deleted closes the confirmation instead of showing an error.

#### Browser tests

Tests that expected a dialog's action to stay disabled until its form was valid should press it and check the field's error instead. Tests that waited for failure toasts such as "Failed to delete" or "Failed to schedule" should look for the error inside the dialog. New toasts such as "Term created" and "Invitation sent to …" use the `dialog` role, so locate dialogs by name.
