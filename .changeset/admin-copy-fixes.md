---
"@emdash-cms/admin": patch
---

Fixes admin copy in three places:

- The field dialog labels the length limits of Short Text, Long Text and Slug fields "Minimum characters" and "Maximum characters", instead of "Min Length" and "Max Length" with no unit.
- Empty Long Text fields no longer show the "Enter markdown content..." placeholder. Long Text stores plain text.
- The Content Types page says that dragging sets the default order of content types in the sidebar. The order applies to everyone. A personal order set in Settings → Sidebars still takes precedence.
