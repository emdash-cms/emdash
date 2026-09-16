---
"emdash": minor
"@emdash-cms/admin": minor
---

Updates plugin discovery to show only the registry. Sites with an enabled `sandboxRunner` use the hosted aggregator at `https://registry.emdashcms.com` by default, while an explicit `experimental.registry` value continues to select custom registry settings.

The `marketplace` integration option is deprecated but remains supported for plugins already installed from Marketplace. Those plugins continue to run and can still be updated or uninstalled from **Plugins**. Marketplace browse and install pages are hidden, and configured sites display a migration guide banner.

#### What should I do?

Keep `marketplace` configured while any installed Marketplace plugin still needs updates. Replace or uninstall those plugins, then remove the option by following the [Marketplace migration guide](https://docs.emdashcms.com/plugins/migrate-from-marketplace/).
