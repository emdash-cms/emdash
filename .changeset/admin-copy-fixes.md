---
"@emdash-cms/admin": patch
---

Fixes admin copy in three places, and the direction of empty text boxes in right-to-left languages:

- The field dialog labels the length limits of Short Text, Long Text and Slug fields "Minimum characters" and "Maximum characters", instead of "Min Length" and "Max Length" with no unit.
- Empty Long Text fields say "Enter plain text..." instead of "Enter markdown content...", since Long Text stores plain text. Empty Short Text fields now say "Enter text...".
- In right-to-left admin languages, empty Short Text and Long Text boxes line up with the page, so their placeholder sits on the right edge until you type.
- The Content Types page says that dragging sets the default order of content types in the sidebar. The order applies to everyone. A personal order set in Settings → Sidebars still takes precedence.
