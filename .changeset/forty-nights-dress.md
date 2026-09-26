---
"emdash": patch
---

Removes the obsolete `emdash plugin login` command, which fails when authenticating with the deprecated Marketplace. This is a breaking CLI change: remove that command from scripts. For the experimental Registry, use `emdash-plugin login <handle-or-did>` with an Atmosphere account; see the [plugin publishing guide](https://docs.emdashcms.com/plugins/creating-plugins/publishing/). CMS login (`emdash login`) is unchanged.
