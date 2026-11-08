---
"@emdash-cms/admin": patch
---

Updates the Users and Bylines tables in the admin to match the content list's look.

On the Users page, clicking a user's name opens their details. The name is a button, so it can be reached with the keyboard now, and clicking elsewhere in the row no longer opens the details.

On the Bylines page, clicking a byline's name opens the edit dialog, and the Edit button moves into the row's "…" menu next to Delete byline.

Browser tests that open "More actions for {name}" on the Bylines page should open "Actions for {name}" instead. The byline's name now has the "Edit {name}" accessible name that the Edit button had, so tests that click "Edit {name}" still open the edit dialog. The Bylines panel in the content editor still uses "More actions for {name}". Tests that clicked a row of the Users table should click the user's name.
