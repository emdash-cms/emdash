---
"@emdash-cms/admin": patch
---

Fixes keyboard focus jumping to the top of the page when the row holding it leaves an admin table, for example after deleting a redirect from its "…" menu, moving an entry to the trash, or approving a comment in the Pending tab. Focus moves to the same control in the row that takes its place, so keyboard and screen-reader users can carry on down the list. When no row takes its place, such as when the last row leaves, focus moves to the "…" button of the row above it instead of a control that would act on a row you didn't choose. Focus stays where you put it when you move it elsewhere, such as into a search box or by clicking, and a mouse or touch press cancels a move that is still waiting for a menu or dialog to close.

On the Redirects page, changes such as toggling a redirect or marking a 404 path as Gone no longer replace the tables with a loading or empty message and drop keyboard focus. After a change, the list still goes back to its first page. Each redirect's switch is now named after its redirect, such as "Disable redirect /old-page", so browser tests that find a switch by its exact name need to include the source path.
