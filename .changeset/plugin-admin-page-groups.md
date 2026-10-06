---
"emdash": patch
"@emdash-cms/admin": patch
"@emdash-cms/plugin-cli": patch
"@emdash-cms/plugin-types": patch
---

Adds `group` to plugin admin pages, in native plugin descriptors and in `admin.pages` of `emdash-plugin.jsonc`, to place them in collapsible admin sidebar folders. A page whose group matches the group of a collection shown in the sidebar appears inside that folder, after its collections and taxonomies. Pages that share any other group, from one plugin or several, fold into one folder in the Plugins section. Pages without a group stay where they are.
