---
"@emdash-cms/admin": patch
---

Fixes **Plugins** and plugin registry pages offering Editors buttons that only an administrator can use. Editors still see the installed plugins and registry listings, but no longer see the controls to enable, disable, update, configure, uninstall or install a plugin, which always failed with a permissions error for them. The switch for a plugin's MCP tools still shows Editors whether the tools are on, but they can't change it.
