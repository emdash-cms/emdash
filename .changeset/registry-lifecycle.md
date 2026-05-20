---
"@emdash-cms/admin": minor
"emdash": minor
---

Plugins installed from the experimental registry can now be uninstalled and updated from the admin, the same way marketplace plugins always could. The "uninstall is not yet available for registry plugins" placeholder is gone — registry plugin rows now show the same Uninstall and Update buttons.

The Plugins page's "updates available" indicator now covers registry plugins too. If the registry aggregator is unreachable, marketplace updates still load (and vice versa).

Updates that need newly-declared permissions, or that newly expose a public (unauthenticated) route, prompt for re-consent before installing the new version — matching the gate that marketplace updates already have.
