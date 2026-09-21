---
"emdash": minor
"@emdash-cms/admin": minor
---

Updates plugin discovery to show only the registry. Sites with an enabled `sandboxRunner` use the hosted aggregator at `https://registry.emdashcms.com` by default. The new top-level `registry` option accepts a registry URL or configuration object, while `registry: false` disables registry discovery and registry-installed plugins without disabling the sandbox runner.

The former `experimental.registry` location is deprecated but remains supported when the top-level option is omitted. A top-level value takes precedence.

The `marketplace` integration option is deprecated but remains supported for plugins already installed from Marketplace. Those plugins continue to run and can still be updated or uninstalled from **Plugins**. Marketplace browse and install pages are hidden, and configured sites display a migration guide banner.

#### What should I do?

Move an existing `experimental.registry` value to the top-level `registry` option. The deprecated location continues to work during the pre-1.0 compatibility period.

Set `registry: false` if the site needs its sandbox runner but should not load registry-installed plugins or expose registry discovery.

Keep `marketplace` configured while any installed Marketplace plugin still needs updates. Replace or uninstall those plugins, then remove the option by following the [Marketplace migration guide](https://docs.emdashcms.com/plugins/migrate-from-marketplace/).
