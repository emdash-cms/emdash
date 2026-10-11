---
"@emdash-cms/admin": patch
---

Fixes admin borders always being drawn in the default gray, which hid the colors that components set. Error, warning, info and success notices that have a border now show it in red, yellow, blue or green. While you drag a file over them, the Featured Image and OG Image drop targets and the media library's drop overlay show a blue border. In the Revisions panel, the selected revision is outlined in blue and its listed changes get green, red or amber outlines. Some other borders, such as table row lines and badge outlines, use slightly different grays. The expanded sidebar no longer draws a line under each section label; the lines still appear when the sidebar is collapsed.
