---
"@emdash-cms/admin": patch
---

Fixes the content editor's Outline panel. Clicking a heading now places the caret at the start of that heading and scrolls it to the top of the editor, where it was often left below the visible area. When the settings panel is shown as a sheet over the editor, it closes so the heading is visible, and tapping a heading on a touch screen no longer opens the on-screen keyboard. Headings nest by the document's structure, so level 4–6 headings are no longer shown at the top level and documents that start at level 2 are not indented. The current section is now marked on the outline's rail and follows the scroll position instead of the caret, and long headings written in the opposite direction to the admin language are truncated at the end.
